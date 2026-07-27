const JAPANESE_RE = /[぀-ゟ゠-ヿ一-龯]/;

/**
 * Check if text contains any hiragana, katakana, or CJK ideograph.
 * @param {string} text
 * @returns {boolean}
 */
export function hasJapanese(text) {
  return !!text && JAPANESE_RE.test(text);
}

/**
 * Sentence-ending punctuation used to mark hoverable "boundary" dots in the
 * auto lite views. Japanese-only on purpose: ASCII . ! ? are common inside
 * URLs, decimals, and abbreviations in free-form chat/Redmine text and would
 * produce false boundaries (Meet captions are cleaner STT output and opt into
 * the wider set via the 'ja-ascii' mark policy).
 */
export const SENTENCE_BOUNDARY_RE = /[。！？]/;

// Kept flagless: both are used as per-character `.test()`, and a /g regex would
// carry lastIndex between characters and silently skip marks.
const MARK_SETS = {
  'ja': SENTENCE_BOUNDARY_RE,
  'ja-ascii': /[。！？.!?]/,
};

/**
 * Shortest unterminated clause that earns a synthetic hover dot. Below this a
 * dot is more noise than help: nav items, buttons and table labels across the
 * open web are mostly one or two words.
 */
export const MIN_SYNTHETIC_CLAUSE_CHARS = 8;

/**
 * Split `text` into clauses, one per sentence-ending punctuation run, plus a
 * final unterminated clause for any trailing text.
 *
 * A clause is the unit a boundary dot translates, so it must never span a
 * newline: the block text assembler represents a nested block or a <br> as a
 * synthetic '\n' with no backing text node, and text either side of one belongs
 * to different visual blocks.
 *
 * A run of marks closes one clause rather than one clause per character, so
 * `！？` yields a single dot.
 *
 * @param {string} text
 * @param {{marks?: 'ja'|'ja-ascii'}} [options]
 * @returns {Array<{
 *   start: number, end: number,
 *   contentStart: number, contentEnd: number,
 *   markStart: number, markEnd: number,
 *   text: string, hasJapanese: boolean, terminated: boolean
 * }>} `start`/`end` bracket the raw slice including surrounding whitespace;
 *   `contentStart`/`contentEnd` bracket the trimmed slice that `text` holds;
 *   `markStart`/`markEnd` bracket the closing mark run, or -1 when unterminated.
 */
export function segmentClauses(text, options = {}) {
  const out = [];
  if (!text) return out;
  const markRe = MARK_SETS[options.marks] || MARK_SETS['ja'];

  let start = 0;
  let i = 0;

  const push = (rawEnd, markStart, markEnd) => {
    // Trim only the leading and trailing whitespace; interior spacing is part
    // of the clause and matters to the translator.
    let cs = start;
    let ce = rawEnd;
    while (cs < ce && /\s/.test(text[cs])) cs++;
    while (ce > cs && /\s/.test(text[ce - 1])) ce--;
    if (ce > cs) {
      const slice = text.slice(cs, ce);
      out.push({
        start,
        end: rawEnd,
        contentStart: cs,
        contentEnd: ce,
        markStart,
        markEnd,
        text: slice,
        hasJapanese: hasJapanese(slice),
        terminated: markStart !== -1,
      });
    }
    start = rawEnd;
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === '\n') {
      push(i, -1, -1);
      start = i + 1;
      i++;
      continue;
    }

    if (markRe.test(ch)) {
      const markStart = i;
      while (i < text.length && markRe.test(text[i])) i++;
      push(i, markStart, i);
      continue;
    }

    i++;
  }

  if (start < text.length) push(text.length, -1, -1);

  return out;
}

// Split on whitespace that follows a terminator, keeping any closing quote or
// bracket with the sentence it closes rather than consuming it as a separator.
const ENGLISH_SENTENCE_SPLIT_RE = /(?<=[.!?]["'”’)\]]*)\s+/;

/**
 * Split an English translation into one part per clause.
 *
 * Returns null unless the split lands on exactly `clauseCount` parts. Guessing
 * an alignment would attach the wrong English to a dot, which is worse than
 * every dot sharing the whole translation, so this fails closed and lets the
 * caller fall back.
 *
 * @param {number} clauseCount
 * @param {string} english
 * @returns {string[]|null}
 */
export function alignClauseTranslations(clauseCount, english) {
  if (!english || clauseCount < 2) return null;
  const parts = String(english).trim().split(ENGLISH_SENTENCE_SPLIT_RE)
    .map(p => p.trim())
    .filter(Boolean);
  return parts.length === clauseCount ? parts : null;
}

/**
 * Simple hash function for text content
 * @param {string} text
 * @returns {number}
 */
export function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash;
}

/**
 * Split Japanese text at natural boundaries for chunked processing
 * @param {string} text - Japanese text to split
 * @param {number} maxChars - Maximum characters per chunk (default 30)
 * @returns {string[]} - Array of text chunks
 */
export function splitJapaneseText(text, maxChars = 30) {
  const chunks = [];
  const separators = /([。、！？\n])/g;

  let current = '';
  const parts = text.split(separators);

  for (const part of parts) {
    if ((current + part).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = part;
    } else {
      current += part;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // If no natural boundaries found, split by maxChars
  if (chunks.length === 0 && text.length > 0) {
    for (let i = 0; i < text.length; i += maxChars) {
      chunks.push(text.slice(i, i + maxChars).trim());
    }
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * Get CSS class suffix for word type
 * @param {string} type - Word type from breakdown
 * @returns {string} - CSS class suffix
 */
export function getWordTypeClass(type) {
  const typeMap = {
    'noun': 'noun',
    'verb': 'verb',
    'particle': 'particle',
    'adjective': 'adjective',
    'adverb': 'adverb',
    'counter': 'counter',
    'expression': 'expression',
    'auxiliary': 'auxiliary',
    'copula': 'copula'
  };
  return typeMap[type?.toLowerCase()] || 'other';
}
