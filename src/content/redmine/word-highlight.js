import { debugLog } from '../core/debug.js';
import { getCachedWords } from '../core/word-cache.js';
import { inlineBreakdownState } from '../core/state.js';
import { collectTextNodes, applyHighlightsToTextNode } from '../utils/highlight.js';
import { getRedmineTextBlocks } from './message-finder.js';

/**
 * Redmine Word Highlight Module
 * Highlights known Japanese words in Redmine text blocks
 */

// Track highlighted blocks to avoid re-processing
const highlightedBlocks = new WeakMap();

/**
 * Highlight known words in a single Redmine text block
 * @param {HTMLElement} blockEl - Redmine text block element
 */
export function highlightRedmineBlock(blockEl) {
  // Skip if already showing full breakdown
  const state = inlineBreakdownState.get(blockEl);
  if (state?.isShowingBreakdown) {
    debugLog('REDMINE-HIGHLIGHT', 'Skipping - block already showing breakdown');
    return;
  }

  // Skip if already highlighted
  if (highlightedBlocks.get(blockEl)) {
    debugLog('REDMINE-HIGHLIGHT', 'Skipping - already highlighted');
    return;
  }

  // Save original HTML before any modifications
  const originalHTML = blockEl.innerHTML;

  const text = blockEl.textContent?.trim() || '';
  if (!text) return;

  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
  if (!hasJapanese) return;

  // Collect <pre> and <code> elements to exclude from highlighting
  const excludeContainer = blockEl.querySelector('pre, code');

  // Collect text nodes (excluding code blocks)
  const textNodes = collectTextNodes(blockEl, excludeContainer);
  if (textNodes.length === 0) return;

  let totalMatches = 0;

  for (const textNode of textNodes) {
    const nodeText = textNode.nodeValue;
    if (!nodeText || !nodeText.trim()) continue;

    const matches = getCachedWords(nodeText);
    if (matches.length === 0) continue;

    totalMatches += matches.length;
    applyHighlightsToTextNode(textNode, matches);
  }

  if (totalMatches === 0) {
    debugLog('REDMINE-HIGHLIGHT', 'No cached words found in block');
    return;
  }

  debugLog('REDMINE-HIGHLIGHT', `Highlighted ${totalMatches} cached words`);

  highlightedBlocks.set(blockEl, {
    originalHTML,
    highlightedHTML: blockEl.innerHTML
  });
}

/**
 * Highlight all visible Redmine text blocks on the page
 */
export function highlightAllRedmineBlocks() {
  const blocks = getRedmineTextBlocks();
  let highlightedCount = 0;

  blocks.forEach((blockEl) => {
    const text = blockEl.textContent?.trim() || '';
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
    if (hasJapanese) {
      highlightRedmineBlock(blockEl);
      highlightedCount++;
    }
  });

  debugLog('REDMINE-HIGHLIGHT', `Auto-highlighted ${highlightedCount} blocks`);
}

/**
 * Clear highlight state for a Redmine text block
 * @param {HTMLElement} blockEl - Text block element
 */
export function clearRedmineHighlightState(blockEl) {
  highlightedBlocks.delete(blockEl);
}

/**
 * Get the pre-highlight (truly original) HTML for a block element
 * @param {HTMLElement} blockEl - Block element
 * @returns {string|null}
 */
export function getPreHighlightHTML(blockEl) {
  return highlightedBlocks.get(blockEl)?.originalHTML || null;
}
