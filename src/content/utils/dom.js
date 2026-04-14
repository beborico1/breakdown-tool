/**
 * Detect whether the page is using a light colour scheme by sampling
 * the computed background-color of document.body.
 * @returns {boolean}
 */
export function isPageLightMode() {
  const bg = window.getComputedStyle(document.body).backgroundColor;
  const match = bg.match(/\d+/g);
  if (!match || match.length < 3) return false;
  const [r, g, b] = match.map(Number);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128;
}

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
