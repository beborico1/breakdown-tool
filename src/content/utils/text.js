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
