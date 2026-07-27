import { debugLog } from '../core/debug.js';
import { getCachedWords, getWordCacheSize } from '../core/word-cache.js';
import { inlineBreakdownState } from '../core/state.js';
import { collectTextNodes, applyHighlightsToTextNode } from '../utils/highlight.js';
import { getGmailMessageBodies } from './message-finder.js';

/**
 * Gmail Word Highlight Module
 * Highlights known Japanese words in Gmail message bodies
 */

// Track highlighted messages to avoid re-processing
const highlightedMessages = new WeakMap();

// messageEl -> word-cache size when it last yielded no matches, so a message
// with nothing to highlight is not re-walked until the cache changes.
const noMatchAtCacheSize = new WeakMap();

/**
 * Highlight known words in a Gmail message body element
 * @param {HTMLElement} messageEl - Gmail message body (.a3s.aiL)
 */
export function highlightGmailMessage(messageEl) {
  // Skip if already showing full breakdown
  const state = inlineBreakdownState.get(messageEl);
  if (state?.isShowingBreakdown) {
    debugLog('GMAIL-HIGHLIGHT', 'Skipping - message already showing breakdown');
    return;
  }

  // Skip if already highlighted
  if (highlightedMessages.get(messageEl)) {
    debugLog('GMAIL-HIGHLIGHT', 'Skipping - already highlighted');
    return;
  }

  // A message that matched nothing was re-walked on every pass, because only
  // successful highlights were recorded. The answer can only change once new
  // words are learned, which invalidates every memo at once.
  if (noMatchAtCacheSize.get(messageEl) === getWordCacheSize()) {
    return;
  }

  // Save original HTML before any modifications
  const originalHTML = messageEl.innerHTML;

  // Check for Japanese characters
  const text = messageEl.textContent?.trim() || '';
  if (!text) return;

  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
  if (!hasJapanese) return;

  // Find quoted block to exclude
  const quotedBlock = messageEl.querySelector('.gmail_quote');

  // Collect text nodes (excluding quoted block)
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
    debugLog('GMAIL-HIGHLIGHT', 'No cached words found in message');
    return;
  }

  debugLog('GMAIL-HIGHLIGHT', `Highlighted ${totalMatches} cached words`);

  // Store original HTML for restoration
  highlightedMessages.set(messageEl, {
    originalHTML,
    highlightedHTML: messageEl.innerHTML
  });
}

/**
 * Highlight all visible Gmail message bodies
 */
export function highlightAllGmailMessages() {
  const messageBodies = getGmailMessageBodies();
  let highlightedCount = 0;

  messageBodies.forEach((messageEl) => {
    const text = messageEl.textContent?.trim() || '';
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
    if (hasJapanese) {
      highlightGmailMessage(messageEl);
      highlightedCount++;
    }
  });

  debugLog('GMAIL-HIGHLIGHT', `Auto-highlighted ${highlightedCount} messages`);
}

/**
 * Clear highlight state for a Gmail message
 * @param {HTMLElement} messageEl - Message element
 */
export function clearGmailHighlightState(messageEl) {
  highlightedMessages.delete(messageEl);
}

/**
 * Get the pre-highlight (truly original) HTML for a message element
 * @param {HTMLElement} messageEl - Message element
 * @returns {string|null}
 */
export function getPreHighlightHTML(messageEl) {
  return highlightedMessages.get(messageEl)?.originalHTML || null;
}
