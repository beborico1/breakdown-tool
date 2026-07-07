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
 * produce false boundaries (Meet captions are cleaner STT output and use a
 * wider set in word-render.js).
 */
export const SENTENCE_BOUNDARY_RE = /[。！？]/;

/**
 * Find every sentence-ending punctuation mark in `text`.
 * @param {string} text
 * @returns {Array<{start: number, end: number}>} one entry per mark, in order
 */
export function findSentenceBoundaries(text) {
  const out = [];
  if (!text) return out;
  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_BOUNDARY_RE.test(text[i])) {
      out.push({ start: i, end: i + 1 });
    }
  }
  return out;
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
