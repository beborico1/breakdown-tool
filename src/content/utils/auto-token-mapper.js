import { getWordTypeClass } from './text.js';
import { createAutoBoundarySpan } from './highlight.js';

const THIN_SPACE = ' ';

// Resolve the annotation group owned by this ruby-base branch before wrapping
// mutates its text nodes. Whitespace/comments and <rp> fallbacks do not break a
// group; once readings begin, the next base branch ends it.
function findRubyReadings(textNode) {
  const ruby = textNode.parentElement?.closest('ruby');
  if (!ruby) return [];

  let branch = textNode;
  while (branch.parentNode && branch.parentNode !== ruby) {
    branch = branch.parentNode;
  }
  if (branch.parentNode !== ruby) return [];

  const readings = [];
  let foundReading = false;
  for (let sibling = branch.nextSibling; sibling; sibling = sibling.nextSibling) {
    if (sibling.nodeType === Node.COMMENT_NODE) continue;
    if (sibling.nodeType === Node.TEXT_NODE && !sibling.nodeValue?.trim()) continue;

    if (sibling.nodeType === Node.ELEMENT_NODE) {
      if (sibling.tagName === 'RP') continue;
      if (sibling.tagName === 'RT') {
        readings.push(sibling);
        foundReading = true;
        continue;
      }
      if (sibling.tagName === 'RTC' && !foundReading) {
        for (const reading of sibling.querySelectorAll('rt')) {
          if (reading.closest('ruby') === ruby) readings.push(reading);
        }
        if (readings.length) foundReading = true;
        continue;
      }
    }

    if (foundReading) break;
    // Multiple base branches may share the following annotation group.
  }

  return readings;
}

function decorateRubyReadings(readings, typeClass, isAltTone) {
  for (const reading of readings) {
    if (reading.classList.contains('gcwb-ruby-reading')) continue;
    reading.classList.add('gcwb-ruby-reading', `gcwb-type-${typeClass}`);
    if (isAltTone) reading.classList.add('gcwb-tone-alt');
  }
}

/**
 * Wrap Japanese tokens inside a single text node, in place, preserving the
 * surrounding DOM. Modeled after applyHighlightsToTextNode in highlight.js,
 * but emits `.gcwb-auto-word` spans + thin spaces between adjacent Japanese
 * tokens.
 *
 * @param {Text} textNode
 * @param {Array<{surface:string,start:number,end:number,word?:string,reading:string,romaji:string,english:string,type:string}>} tokens
 *   Local-offset tokens (start/end are offsets INTO this text node), in order.
 *   `surface` is the exact slice of this node. `word` (optional) is the full
 *   word when the token is one segment of a word split across text nodes; it
 *   feeds data-word so the hover card shows the whole word.
 * @param {{decorateNativeRuby?: boolean}} [opts] - When true, copy each
 *   painted ruby base's POS/tone classes to its annotation-only <rt> group.
 */
export function wrapJapaneseTokensInTextNode(textNode, tokens, opts = {}) {
  if (!tokens?.length) return;
  const { decorateNativeRuby = false } = opts;
  const parent = textNode.parentNode;
  if (!parent) return;
  const rubyReadings = decorateNativeRuby ? findRubyReadings(textNode) : [];

  let currentNode = textNode;
  let consumed = 0;
  let prevEnd = -1;
  let prevType = null;
  let tone = 0;

  for (const t of tokens) {
    const relStart = t.start - consumed;
    if (relStart > 0) {
      currentNode = currentNode.splitText(relStart);
      consumed += relStart;
    }

    const wordLen = t.surface.length;
    const afterNode = currentNode.splitText(wordLen);
    consumed += wordLen;

    if (t.isBoundary) {
      const span = createAutoBoundarySpan(t.english);
      span.appendChild(document.createTextNode(t.surface));
      parent.replaceChild(span, currentNode);
      currentNode = afterNode;
      // Hard break: no thin space, restart the tone run for following words.
      prevEnd = -1;
      prevType = null;
      tone = 0;
      continue;
    }

    const typeClass = getWordTypeClass(t.type);
    // Tone state is node-local, so segments of a word split across nodes can
    // land on different tones when the head follows a same-type word in its
    // node; accepted as a subtle shade difference.
    tone = (t.type && t.type === prevType) ? 1 - tone : 0;
    const toneClass = tone === 1 ? ' gcwb-tone-alt' : '';

    const span = document.createElement('span');
    span.className = `gcwb-auto-word gcwb-type-${typeClass}${toneClass}`;
    span.dataset.word = t.word || t.surface;
    span.dataset.reading = t.reading || '';
    span.dataset.romaji = t.romaji || '';
    span.dataset.english = t.english || '';
    span.dataset.type = typeClass;
    span.appendChild(document.createTextNode(t.surface));

    if (decorateNativeRuby) {
      decorateRubyReadings(rubyReadings, typeClass, tone === 1);
    }

    // Insert thin space if previous token ended exactly where this one starts.
    if (prevEnd === t.start) {
      parent.insertBefore(document.createTextNode(THIN_SPACE), currentNode);
    }

    parent.replaceChild(span, currentNode);

    currentNode = afterNode;
    prevEnd = t.end;
    prevType = t.type;
  }
}
