/**
 * Hide the original element and mark it as shadow
 * @param {HTMLElement} originalEl
 */
export function hideOriginalElement(originalEl) {
  originalEl.style.cssText = 'position:absolute;opacity:0;pointer-events:none;height:0;overflow:hidden';
  originalEl.setAttribute('data-shadow-original', 'true');
}

/**
 * Build ruby HTML for a word with furigana
 * @param {string} japanese - Japanese word
 * @param {string} reading - Hiragana reading (empty if no kanji)
 * @returns {string} - HTML string with ruby if needed
 */
export function buildRubyHtml(japanese, reading) {
  if (!reading || reading === japanese) {
    // No furigana needed (already hiragana/katakana or reading matches)
    return `<span class="word-segment">${japanese}</span>`;
  }
  return `<ruby class="word-segment">${japanese}<rt>${reading}</rt></ruby>`;
}
