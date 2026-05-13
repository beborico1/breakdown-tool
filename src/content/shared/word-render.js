import { getWordTypeClass } from '../utils/text.js';

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
export function buildWordBoundaries(text, words) {
  const boundaries = [];
  let searchStart = 0;

  for (const word of words) {
    if (!word?.japanese) continue;
    const idx = text.indexOf(word.japanese, searchStart);
    if (idx !== -1) {
      boundaries.push({
        startIdx: idx,
        endIdx: idx + word.japanese.length,
        word,
      });
      searchStart = idx + word.japanese.length;
    }
  }

  return boundaries;
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
  const boundaries = buildWordBoundaries(text, words || []);
  const sents = Array.isArray(sentences) && sentences.length > 0 ? sentences : null;

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
      prevType = word.type;
      html += `<span class="mm-word mm-type-${typeClass}${toneClass}" data-word="${escapeHtml(word.japanese)}" data-reading="${escapeHtml(word.reading || '')}" data-romaji="${escapeHtml(word.romaji || '')}" data-english="${escapeHtml(word.english || '')}" data-type="${escapeHtml(typeClass)}">${escapeHtml(segment)}</span>`;
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
