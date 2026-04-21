/**
 * Detect whether the page is using a light colour scheme by sampling
 * the computed background-color of document.body.
 * @returns {boolean}
 */
export function isPageLightMode(referenceEl = null) {
  // Build referenceEl → root ancestor chain plus body/html as fallbacks.
  const chain = [];
  let el = referenceEl;
  while (el) { chain.push(el); el = el.parentElement; }
  for (const fb of [document.body, document.documentElement]) {
    if (fb && !chain.includes(fb)) chain.push(fb);
  }

  // First opaque background wins. Skip semi-transparent backgrounds — they're
  // hover/selection overlays (e.g. rgba(0,0,0,0.08) on a right-clicked
  // message) that would invert the detected theme if we read them as solid.
  const OPAQUE = 0.5;
  for (const node of chain) {
    const bg = window.getComputedStyle(node).backgroundColor;
    const m = bg.match(/[\d.]+/g);
    if (!m || m.length < 3) continue;
    const [r, g, b, a = 1] = m.map(Number);
    if (a < OPAQUE) continue;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 128;
  }

  // Inside threads everything above the message can be transparent. Fall back
  // to text colour, which Gmail/Chat set per theme. Start from
  // referenceEl.parentElement so we skip the popover's own anchor (e.g.
  // .gcwb-word, which we colour ourselves via .gcwb-type-*).
  let scan = referenceEl?.parentElement || document.body;
  while (scan) {
    const fg = window.getComputedStyle(scan).color;
    const m = fg.match(/[\d.]+/g);
    if (m && m.length >= 3) {
      const [r, g, b, a = 1] = m.map(Number);
      if (a >= OPAQUE) return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
    }
    scan = scan.parentElement;
  }

  return !window.matchMedia('(prefers-color-scheme: dark)').matches;
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
