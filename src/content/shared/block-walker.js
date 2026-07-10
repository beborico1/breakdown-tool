import { hasJapanese } from '../utils/text.js';

/**
 * Generic Block Walker
 * Finds block elements on an arbitrary page that contain Japanese text and
 * should be colorized. Used by the universal (all-sites) colorizer.
 */

// Tags whose subtree is never analyzed (and never walked into for text).
export const SKIP_SUBTREE_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
  'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  'CODE', 'PRE', 'KBD', 'SAMP',
  'SVG', 'MATH', 'CANVAS',
  'VIDEO', 'AUDIO', 'IMG', 'OBJECT', 'EMBED', 'IFRAME',
  'RUBY', 'RT', 'RP',   // already-furiganated text — leave the site's reading alone
  'SUP', 'SUB',         // fake-furigana readings and footnote marks — not body text
  'TIME',               // usually machine-readable
]);

// Semantic structural tags: always block boundaries regardless of CSS, so an
// inline-styled nav `<li>` or table cell never fuses with its siblings.
const SEMANTIC_BLOCK_TAGS = new Set([
  'P', 'LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SUMMARY', 'LABEL',
  'ARTICLE', 'SECTION', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN',
]);

// Fallback classification for elements without a resolvable computed display
// (display:none or detached): these default-block containers stay boundaries,
// everything else is treated as inline flow.
const BLOCK_DEFAULT_TAGS = new Set([
  'DIV', 'UL', 'OL', 'DL', 'TABLE', 'FORM', 'NAV', 'FIGURE',
  'FIELDSET', 'ADDRESS', 'DETAILS', 'DIALOG', 'BODY', 'HTML',
]);

/**
 * Whether `el` establishes a block boundary (an analyze-unit edge).
 *
 * Semantic structural tags always do. Generic containers (SPAN, DIV, A,
 * custom elements, ...) are classified by computed display: inline-level
 * displays (`inline`, `inline-block`, ...), `contents`, and ruby internals do
 * NOT bound a block — fake-furigana `<span class="wruby">` wrappers must merge
 * into their paragraph so words tokenize with full sentence context. Flex and
 * grid items blockify at computed-value time, so bubble-style spans in flex
 * rows classify as blocks on their own. `display:none` elements are blocks:
 * they own their (currently invisible) text as a separate unit — kept out of
 * the visible flow's analyzer input — and paint when revealed. Detached
 * elements have no resolvable display and fall back to tag defaults.
 *
 * @param {Element} el
 * @param {Map<Element, boolean>|null} [cache] - per-call cache; computed
 *   display can change between scans, so never persist this across calls.
 * @returns {boolean}
 */
export function isBlockLevel(el, cache) {
  const hit = cache?.get(el);
  if (hit !== undefined) return hit;

  let block;
  if (SEMANTIC_BLOCK_TAGS.has(el.tagName)) {
    block = true;
  } else {
    let d = '';
    try { d = getComputedStyle(el).display || ''; } catch { d = ''; }
    if (d === 'none') {
      block = true;
    } else if (d === '') {
      block = BLOCK_DEFAULT_TAGS.has(el.tagName);
    } else {
      // includes, not startsWith: vendor-prefixed inline-level values like
      // -webkit-inline-box must not bound a block either.
      block = !(d.includes('inline') || d === 'contents' || d.startsWith('ruby'));
    }
  }

  cache?.set(el, block);
  return block;
}

/**
 * Resolve the owning block for a text node: the nearest block-level ancestor
 * (innermost wins). Returns null when the node must be skipped — excluded
 * subtree, editable region, existing word span, escape hatch, or an owning
 * block that is already painted. The painted-marker check applies only to the
 * owning block, never to higher ancestors: a painted parent must not starve
 * its not-yet-painted child blocks on rescans.
 *
 * @param {Text} textNode
 * @param {HTMLElement} root
 * @param {Map<Element, boolean>} cache
 * @returns {HTMLElement|null}
 */
function resolveBlock(textNode, root, cache) {
  let el = textNode.parentElement;
  const stop = root.parentElement;
  let block = null;
  while (el && el !== stop) {
    if (SKIP_SUBTREE_TAGS.has(el.tagName)) return null;
    if (el.isContentEditable) return null;
    if (el.getAttribute?.('role') === 'textbox') return null;
    if (el.classList?.contains('gcwb-auto-word') || el.classList?.contains('gcwb-cached-word')) return null;
    if (el.dataset?.gcwbSkip != null) return null;
    if (!block && isBlockLevel(el, cache)) {
      if (el.dataset?.gcwbUniv === '1') return null; // owning block already painted
      block = el;
    }
    el = el.parentElement;
  }
  return block || textNode.parentElement;
}

/**
 * Find block elements under `root` that contain Japanese text. Each text node
 * maps to exactly one owning block (innermost block-level ancestor). Nested
 * results are expected: a parent block owns only the text outside its child
 * blocks (assembly stops at nested blocks), so parent and child units are
 * disjoint and both must be returned.
 *
 * @param {HTMLElement} [root=document.body]
 * @param {{maxBlocks?: number}} [opts]
 * @returns {HTMLElement[]}
 */
export function findJapaneseBlocks(root = document.body, opts = {}) {
  const { maxBlocks = 300 } = opts;
  if (!root) return [];

  const blocks = new Set();
  const styleCache = new Map();
  let capped = false;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue;
      return v && hasJapanese(v) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  while (walker.nextNode()) {
    const block = resolveBlock(walker.currentNode, root, styleCache);
    if (block) blocks.add(block);
    if (blocks.size >= maxBlocks) { capped = true; break; }
  }

  if (capped) {
    console.warn(`[kaigi-universal] block cap (${maxBlocks}) reached; remaining Japanese will paint on scroll/mutation`);
  }

  return [...blocks];
}
