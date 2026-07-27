import { getWordTypeClass } from '../utils/text.js';
import { isAnkiAdded } from '../core/anki-added.js';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build word boundaries from breakdown data by scanning for each word's
 * Japanese form in the original text. Words that don't match (rare, e.g.
 * Gemini returned a normalized form) are skipped.
 */
const ASCII_ONLY_RE = /^[\x20-\x7e]+$/;

function findSurfaceIdx(text, needle, from) {
  let idx = text.indexOf(needle, from);
  if (idx !== -1) return idx;
  // ASCII tokens may come back from kuromoji with different casing than the
  // source (e.g. "URL" vs "url"). Retry case-insensitively in that case only.
  if (ASCII_ONLY_RE.test(needle)) {
    const hay = text.slice(from).toLowerCase();
    const off = hay.indexOf(needle.toLowerCase());
    if (off !== -1) return from + off;
  }
  return -1;
}

export function buildWordBoundaries(text, words) {
  const boundaries = [];
  let searchStart = 0;

  for (const word of words) {
    if (!word?.japanese) continue;
    const idx = findSurfaceIdx(text, word.japanese, searchStart);
    if (idx !== -1) {
      boundaries.push({
        startIdx: idx,
        endIdx: idx + word.japanese.length,
        word,
      });
      searchStart = idx + word.japanese.length;
    } else if (typeof console !== 'undefined') {
      console.debug?.('[word-render] dropped unmatched word:', word.japanese);
    }
  }

  return boundaries;
}

/**
 * Sentence-scoped boundary builder. Re-anchors each processed sentence's text
 * inside the *current* `text`, then matches only that sentence's own words
 * within that range. This contains the damage when Meet's speech engine revises
 * already-processed text: a revised sentence simply fails to anchor and stays
 * plain, instead of a common particle false-matching into a later sentence and
 * cascading the whole caption to gray.
 *
 * Returns `{ boundaries, anchoredSentences }` where `anchoredSentences` carry
 * fresh `startIndex`/`endIndex` (in current `text` coordinates) for boundary
 * translation lookup.
 */
function buildScopedBoundaries(text, sentences) {
  const boundaries = [];
  const anchoredSentences = [];
  let cursor = 0;

  for (const sentence of sentences) {
    const sentText = sentence?.text;
    if (!sentText) {
      // A record with no text can never anchor, so the whole caption would fall
      // back to plain text. That is a caller bug, not a revised sentence, so it
      // gets its own message rather than sharing the one below.
      if (typeof console !== 'undefined') {
        console.debug?.('[word-render] sentence record has no text field; nothing will paint');
      }
      continue;
    }
    const at = text.indexOf(sentText, cursor);
    if (at === -1) {
      // Sentence was revised out of the current text — skip it (stays plain),
      // and do not advance the cursor past a false position.
      if (typeof console !== 'undefined') {
        console.debug?.('[word-render] dropped unanchored sentence:', sentText.slice(0, 40));
      }
      continue;
    }

    const end = at + sentText.length;
    const scoped = text.slice(at, end);
    const words = sentence.breakdownData?.words || [];
    let searchStart = 0;

    for (const word of words) {
      if (!word?.japanese) continue;
      const idx = findSurfaceIdx(scoped, word.japanese, searchStart);
      if (idx !== -1) {
        boundaries.push({
          startIdx: at + idx,
          endIdx: at + idx + word.japanese.length,
          word,
        });
        searchStart = idx + word.japanese.length;
      } else if (typeof console !== 'undefined') {
        console.debug?.('[word-render] dropped unmatched word:', word.japanese);
      }
    }

    anchoredSentences.push({
      ...sentence,
      startIndex: at,
      endIndex: end,
    });
    cursor = end;
  }

  return { boundaries, anchoredSentences };
}

/**
 * Paint an element with colored, hoverable spans per word. Preserves the
 * visible text exactly; un-matched gaps stay as plain (gray) text.
 */
const BOUNDARY_MARKS = /[。！？.!?]/;

const METADATA_BRACKET_RE = /\[[^\]]*\]/;
const DEGENERATE_TRANSLATION_WORDS = new Set([
  'period', 'full stop', 'comma', 'question mark', 'exclamation mark',
  'exclamation point', 'dot', 'ellipsis', 'punctuation',
]);

function isDegenerateTranslation(t) {
  if (!t) return true;
  const trimmed = String(t).trim();
  if (!trimmed) return true;
  if (METADATA_BRACKET_RE.test(trimmed)) return true;
  const stripped = trimmed.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!stripped) return true;
  if (DEGENERATE_TRANSLATION_WORDS.has(trimmed.toLowerCase().replace(/[.!?]+$/, ''))) return true;
  return false;
}

export function paintWordColoring(messageEl, text, words, sentences) {
  if (!messageEl || !text) return;
  const hasSentences = Array.isArray(sentences) && sentences.length > 0;
  // With sentence data we re-anchor per sentence (robust against Meet revising
  // already-processed text). Without it (pre-cache / tail paint that passes only
  // a flat word list) we fall back to the greedy whole-text scan.
  const { boundaries, sents } = hasSentences
    ? (() => {
        const scoped = buildScopedBoundaries(text, sentences);
        return { boundaries: scoped.boundaries, sents: scoped.anchoredSentences };
      })()
    : { boundaries: buildWordBoundaries(text, words || []), sents: null };

  let html = '';
  let i = 0;
  let bIdx = 0;
  let sIdx = 0;
  let prevType = null;
  let tone = 0;

  const sentenceTranslationAt = (idx) => {
    if (!sents) return null;
    while (sIdx < sents.length && sents[sIdx].endIndex <= idx) sIdx++;
    const s = sents[sIdx];
    if (!s) return null;
    if (idx >= s.startIndex && idx < s.endIndex) {
      const own = s.breakdownData?.translation || null;
      if (own && !isDegenerateTranslation(own)) return own;
      for (let j = sIdx - 1; j >= 0; j--) {
        const prev = sents[j]?.breakdownData?.translation;
        if (prev && !isDegenerateTranslation(prev)) return prev;
      }
      return own;
    }
    return null;
  };

  while (i < text.length) {
    const boundary = boundaries[bIdx];
    if (boundary && i === boundary.startIdx) {
      const word = boundary.word;
      const typeClass = getWordTypeClass(word.type);
      const segment = text.slice(boundary.startIdx, boundary.endIdx);
      tone = (word.type && word.type === prevType) ? 1 - tone : 0;
      const toneClass = tone === 1 ? ' mm-tone-alt' : '';
      const addedClass = isAnkiAdded(word.japanese) ? ' gcwb-anki-added' : '';
      prevType = word.type;
      html += `<span class="mm-word mm-type-${typeClass}${toneClass}${addedClass}" data-word="${escapeHtml(word.japanese)}" data-reading="${escapeHtml(word.reading || '')}" data-romaji="${escapeHtml(word.romaji || '')}" data-english="${escapeHtml(word.english || '')}" data-type="${escapeHtml(typeClass)}">${escapeHtml(segment)}</span>`;
      i = boundary.endIdx;
      bIdx++;
    } else {
      const ch = text[i];
      if (BOUNDARY_MARKS.test(ch)) {
        const translation = sentenceTranslationAt(i);
        if (translation) {
          html += `<span class="mm-boundary" data-english="${escapeHtml(translation)}">${escapeHtml(ch)}</span>`;
        } else {
          html += escapeHtml(ch);
        }
      } else {
        html += escapeHtml(ch);
      }
      i++;
      prevType = null;
      tone = 0;
    }
  }

  messageEl.innerHTML = html;
  messageEl.setAttribute('data-mm-colored', 'true');
}
