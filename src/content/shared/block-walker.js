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
  'TIME',               // usually machine-readable
]);

// "Block-ish" tags. The nearest such ancestor of a Japanese text node becomes
// the analyze unit. The coarse fallbacks at the end are only chosen when no
// finer block ancestor exists (e.g. `<div>日本語</div>` with no inner <p>).
const BLOCK_TAGS = new Set([
  'P', 'LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SUMMARY', 'LABEL',
  'ARTICLE', 'SECTION', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'DIV', 'SPAN',
]);

/**
 * Whether any ancestor (up to root) means this text node must be skipped:
 * excluded subtree, editable region, already-painted span, or escape hatch.
 * @param {HTMLElement|null} el - parent element of the text node
 * @param {HTMLElement} root
 * @returns {boolean}
 */
function isSkippedAncestor(el, root) {
  let p = el;
  const stop = root.parentElement;
  while (p && p !== stop) {
    if (SKIP_SUBTREE_TAGS.has(p.tagName)) return true;
    if (p.isContentEditable) return true;
    if (p.getAttribute?.('role') === 'textbox') return true;
    if (p.classList?.contains('gcwb-auto-word') || p.classList?.contains('gcwb-cached-word')) return true;
    if (p.dataset?.gcwbSkip != null) return true;
    if (p.dataset?.gcwbUniv === '1') return true; // already-painted universal block
    p = p.parentElement;
  }
  return false;
}

/**
 * Resolve the nearest block ancestor for a text node (innermost block wins).
 * @param {Text} textNode
 * @param {HTMLElement} root
 * @returns {HTMLElement|null}
 */
function nearestBlock(textNode, root) {
  let el = textNode.parentElement;
  const stop = root.parentElement;
  while (el && el !== stop) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return textNode.parentElement;
}

/**
 * Find block elements under `root` that contain Japanese text. Innermost block
 * wins, so a text node maps to exactly one block — preventing nested
 * parent+child double-processing and the merging of unrelated paragraphs.
 *
 * @param {HTMLElement} [root=document.body]
 * @param {{maxBlocks?: number}} [opts]
 * @returns {HTMLElement[]}
 */
export function findJapaneseBlocks(root = document.body, opts = {}) {
  const { maxBlocks = 300 } = opts;
  if (!root) return [];

  const blocks = new Set();
  let capped = false;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue;
      if (!v || !hasJapanese(v)) return NodeFilter.FILTER_REJECT;
      if (isSkippedAncestor(node.parentElement, root)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    const block = nearestBlock(walker.currentNode, root);
    if (block) blocks.add(block);
    if (blocks.size >= maxBlocks) { capped = true; break; }
  }

  if (capped) {
    console.warn(`[kaigi-universal] block cap (${maxBlocks}) reached; remaining Japanese will paint on scroll/mutation`);
  }

  // Defensive: drop any collected block that contains another collected block.
  // Capped above, so this O(n^2) contains-filter stays bounded.
  const arr = [...blocks];
  return arr.filter(b => !arr.some(other => other !== b && b.contains(other)));
}
