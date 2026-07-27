import {
  getWordTypeClass,
  segmentClauses,
  alignClauseTranslations,
  MIN_SYNTHETIC_CLAUSE_CHARS,
} from '../utils/text.js';
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
      clauseParts: buildClauseParts(sentText, at, sentence.breakdownData?.translation),
    });
    cursor = end;
  }

  return { boundaries, anchoredSentences };
}

/**
 * Pair each Japanese clause of a sentence chunk with its own slice of the
 * chunk's English, in current-text coordinates.
 *
 * A chunk holds up to `sentenceChunkSize` sentences and is translated as one
 * unit, so without this every mark in the chunk reveals the same multi-sentence
 * English. Returns null when the English cannot be split to match, in which case
 * the caller falls back to the whole-chunk translation.
 *
 * @param {string} sentText - the chunk's text
 * @param {number} at - where the chunk anchors in the current text
 * @param {string} [translation]
 * @returns {Array<{start: number, end: number, contentEnd: number, terminated: boolean, translation: string}>|null}
 */
function buildClauseParts(sentText, at, translation) {
  const clauses = segmentClauses(sentText, { marks: 'ja-ascii' }).filter(c => c.hasJapanese);
  if (clauses.length < 2) return null;
  const parts = alignClauseTranslations(clauses.length, translation);
  if (!parts) return null;
  return clauses.map((c, i) => ({
    start: at + c.start,
    end: at + c.end,
    contentEnd: at + c.contentEnd,
    terminated: c.terminated,
    text: c.text,
    translation: parts[i],
  }));
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
  let prevType = null;
  let tone = 0;

  // A plain index lookup rather than a monotonic cursor: synthetic dots are
  // resolved out of order relative to the paint loop, and a cursor would be
  // dragged past sentences it still needs.
  const sentenceTranslationAt = (idx) => {
    if (!sents) return null;
    const sIdx = sents.findIndex(s => idx >= s.startIndex && idx < s.endIndex);
    if (sIdx === -1) return null;
    const s = sents[sIdx];

    // Prefer the clause that actually contains this index.
    const part = s.clauseParts?.find(p => idx >= p.start && idx < p.end);
    if (part && !isDegenerateTranslation(part.translation)) return part.translation;

    const own = s.breakdownData?.translation || null;
    if (own && !isDegenerateTranslation(own)) return own;
    for (let j = sIdx - 1; j >= 0; j--) {
      const prev = sents[j]?.breakdownData?.translation;
      if (prev && !isDegenerateTranslation(prev)) return prev;
    }
    return own;
  };

  // Offsets where a clause ends without a closing mark, so an unterminated
  // phrase is still hoverable. Only anchored sentences contribute: the live tail
  // Meet is still revising must not sprout a dot that moves on every update.
  const syntheticAnchors = [];
  if (sents) {
    for (const s of sents) {
      const clauses = s.clauseParts
        || segmentClauses(s.text || '', { marks: 'ja-ascii' })
          .filter(c => c.hasJapanese)
          .map(c => ({
            contentEnd: s.startIndex + c.contentEnd,
            terminated: c.terminated,
            text: c.text,
          }));
      for (const c of clauses) {
        if (c.terminated) continue;
        if ((c.text?.length || 0) < MIN_SYNTHETIC_CLAUSE_CHARS) continue;
        syntheticAnchors.push(c.contentEnd);
      }
    }
    syntheticAnchors.sort((a, b) => a - b);
  }

  let aIdx = 0;
  // The paint loop jumps over whole words, so anchors are flushed by position
  // rather than visited one character at a time.
  const emitSyntheticsUpTo = (limit) => {
    while (aIdx < syntheticAnchors.length && syntheticAnchors[aIdx] <= limit) {
      const anchor = syntheticAnchors[aIdx];
      aIdx++;
      // Look up just inside the clause: an anchor sitting exactly on a
      // sentence's endIndex belongs to the sentence that ends there.
      const translation = sentenceTranslationAt(anchor - 1);
      if (!translation) continue;
      html += `<span class="mm-boundary mm-boundary-synthetic" data-english="${escapeHtml(translation)}"></span>`;
    }
  };

  while (i < text.length) {
    emitSyntheticsUpTo(i);
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
  emitSyntheticsUpTo(text.length);

  messageEl.innerHTML = html;
  messageEl.setAttribute('data-mm-colored', 'true');
}
