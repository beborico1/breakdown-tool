import { debugLog } from '../core/debug.js';
import { getCachedWords, getWordCacheSize } from '../core/word-cache.js';
import { inlineBreakdownState } from '../core/state.js';
import { isOfflineNlpEnabledSync } from '../core/api.js';
import { collectTextNodes, applyHighlightsToTextNode } from '../utils/highlight.js';
import { findChatMessageElement, extractChatMessageText, findQuotedBlockContainer } from './message-finder.js';

/**
 * Word Highlight Module
 * Highlights known Japanese words in chat messages automatically
 * Uses DOM-preserving TreeWalker to maintain line breaks and skip quoted blocks
 */

// Track highlighted messages to avoid re-processing
const highlightedMessages = new WeakMap();

// messageEl -> word-cache size when it last yielded no matches, so a message
// that has nothing to highlight is not re-walked until the cache changes.
const noMatchAtCacheSize = new WeakMap();

/**
 * Highlight known words in a message element using DOM-preserving TreeWalker.
 * Preserves line breaks, links, and other HTML structure.
 * Skips quoted reply blocks.
 * @param {HTMLElement} messageEl - Message element to process
 */
export function highlightKnownWords(messageEl) {
  // Skip when offline NLP / auto-lite is active: auto-analyze paints the full word
  // list in place, so the cached-word highlighter is redundant — and worse, its
  // partial spans fragment the text node and make auto-lite drop tokens that straddle
  // the resulting boundary (leaving e.g. 思 black). Let auto-lite be the sole colorer.
  if (isOfflineNlpEnabledSync()) return;

  // Skip if already showing full breakdown
  const state = inlineBreakdownState.get(messageEl);
  if (state?.isShowingBreakdown) {
    debugLog('WORD-HIGHLIGHT', 'Skipping - message already showing breakdown');
    return;
  }

  // Skip if already highlighted
  if (highlightedMessages.get(messageEl)) {
    debugLog('WORD-HIGHLIGHT', 'Skipping - already highlighted');
    return;
  }

  // A message that matched nothing was re-walked on every pass, because only
  // successful highlights were recorded. Remember the miss against the cache
  // size that produced it: the answer can only change once new words are
  // learned, and then every memo is invalidated at once.
  if (noMatchAtCacheSize.get(messageEl) === getWordCacheSize()) {
    return;
  }

  // Skip if the auto lite view has taken over this message.
  if (messageEl.querySelector('.gcwb-auto-word')) {
    debugLog('WORD-HIGHLIGHT', 'Skipping - auto lite view active');
    return;
  }

  // Save original HTML before any modifications
  const originalHTML = messageEl.innerHTML;

  // Check for Japanese characters using extractChatMessageText (excludes quoted blocks)
  const text = extractChatMessageText(messageEl);
  if (!text) return;

  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
  if (!hasJapanese) return;

  // Find quoted block container to skip
  const quotedBlock = findQuotedBlockContainer(messageEl);

  // Collect text nodes (excluding quoted block and hidden spans)
  const textNodes = collectTextNodes(messageEl, quotedBlock);
  if (textNodes.length === 0) return;

  let totalMatches = 0;

  // Process each text node independently
  for (const textNode of textNodes) {
    const nodeText = textNode.nodeValue;
    if (!nodeText || !nodeText.trim()) continue;

    const matches = getCachedWords(nodeText);
    if (matches.length === 0) continue;

    totalMatches += matches.length;
    applyHighlightsToTextNode(textNode, matches);
  }

  if (totalMatches === 0) {
    noMatchAtCacheSize.set(messageEl, getWordCacheSize());
    debugLog('WORD-HIGHLIGHT', 'No cached words found in message');
    return;
  }

  debugLog('WORD-HIGHLIGHT', `Highlighted ${totalMatches} cached words`);

  // Store original HTML for restoration
  highlightedMessages.set(messageEl, {
    originalHTML,
    highlightedHTML: messageEl.innerHTML
  });
}

/**
 * Highlight all visible messages that contain Japanese text
 */
export function highlightAllMessages() {
  // Auto-lite owns coloring when offline NLP is on — skip the whole pass (see
  // highlightKnownWords for why).
  if (isOfflineNlpEnabledSync()) return;

  const messageTextElements = document.querySelectorAll('.Zc1Emd');
  let highlightedCount = 0;

  messageTextElements.forEach((textEl) => {
    const messageEl = findChatMessageElement(textEl);
    if (messageEl) {
      const text = extractChatMessageText(messageEl);
      const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
      if (hasJapanese) {
        highlightKnownWords(messageEl);
        highlightedCount++;
      }
    }
  });

  debugLog('WORD-HIGHLIGHT', `Auto-highlighted ${highlightedCount} messages`);
}

/**
 * Check if a message is currently highlighted
 * @param {HTMLElement} messageEl - Message element to check
 * @returns {boolean}
 */
export function isHighlighted(messageEl) {
  return highlightedMessages.has(messageEl);
}

/**
 * Clear highlight state for a message (called when full breakdown is shown)
 * @param {HTMLElement} messageEl - Message element
 */
export function clearHighlightState(messageEl) {
  highlightedMessages.delete(messageEl);
}

/**
 * Get the pre-highlight (truly original) HTML for a message element
 * @param {HTMLElement} messageEl - Message element
 * @returns {string|null} - Original HTML before highlighting, or null
 */
export function getPreHighlightHTML(messageEl) {
  return highlightedMessages.get(messageEl)?.originalHTML || null;
}
