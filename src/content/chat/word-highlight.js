import { debugLog } from '../core/debug.js';
import { getCachedWords } from '../core/word-cache.js';
import { inlineBreakdownState } from '../core/state.js';
import { getWordTypeClass } from '../utils/text.js';
import { findChatMessageElement, extractChatMessageText } from './message-finder.js';

/**
 * Word Highlight Module
 * Highlights known Japanese words in chat messages automatically
 * Uses DOM-preserving TreeWalker to maintain line breaks and skip quoted blocks
 */

// Track highlighted messages to avoid re-processing
const highlightedMessages = new WeakMap();

/**
 * Find the outermost quoted block container within a message element.
 * Google Chat reply messages have hidden spans containing "Quoted" / "End Quote"
 * accessibility text. We find those, then walk up to the direct child of messageEl.
 * @param {HTMLElement} messageEl - Message element
 * @returns {HTMLElement|null} - The quoted block container, or null
 */
function findQuotedBlockContainer(messageEl) {
  const hiddenSpans = messageEl.querySelectorAll('span[style*="display: none"], span[style*="display:none"]');
  for (const span of hiddenSpans) {
    const text = span.textContent?.trim().toLowerCase() || '';
    if (text === 'quoted' || text === 'end quote' || text.includes('end quote')) {
      // Walk up to the direct child of messageEl
      let node = span;
      while (node.parentElement && node.parentElement !== messageEl) {
        node = node.parentElement;
      }
      if (node.parentElement === messageEl) {
        return node;
      }
    }
  }
  return null;
}

/**
 * Collect text nodes from a root element using TreeWalker, skipping:
 * - Nodes inside the quoted block container
 * - Nodes inside hidden spans (display: none)
 * - Nodes inside already-highlighted spans (.gcwb-cached-word)
 * @param {HTMLElement} root - Root element to walk
 * @param {HTMLElement|null} excludeContainer - Quoted block to skip
 * @returns {Text[]} - Array of text nodes to process
 */
function collectTextNodes(root, excludeContainer) {
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip nodes inside excluded container (quoted block)
      if (excludeContainer && excludeContainer.contains(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip nodes inside hidden spans
      const parentEl = node.parentElement;
      if (parentEl) {
        if (parentEl.style?.display === 'none' ||
            parentEl.closest('span[style*="display: none"], span[style*="display:none"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip nodes inside already-highlighted spans
        if (parentEl.closest('.gcwb-cached-word')) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }
  return textNodes;
}

/**
 * Apply word highlights to a single text node by splitting it and wrapping
 * matched portions in styled spans. Uses DOM APIs (splitText + createElement)
 * to preserve surrounding HTML structure.
 * @param {Text} textNode - Text node to process
 * @param {Array<{word: string, start: number, end: number, data: Object}>} matches - Sorted matches
 */
function applyHighlightsToTextNode(textNode, matches) {
  if (matches.length === 0) return;

  const parent = textNode.parentNode;
  if (!parent) return;

  // Process matches from end to start to keep offsets stable,
  // but we received them sorted start-to-end, so reverse.
  // Actually, let's process forward and track offset shifts via splitText.

  let currentNode = textNode;
  let consumedOffset = 0;

  for (const match of matches) {
    const relativeStart = match.start - consumedOffset;
    const wordLength = match.word.length;

    // Split off the text before the match (if any)
    if (relativeStart > 0) {
      currentNode = currentNode.splitText(relativeStart);
      consumedOffset += relativeStart;
    }

    // Split off the text after the match
    const afterNode = currentNode.splitText(wordLength);
    consumedOffset += wordLength;

    // Create the highlight span
    const typeClass = getWordTypeClass(match.data.type);
    const span = document.createElement('span');
    span.className = `gcwb-cached-word gcwb-type-${typeClass}`;
    span.dataset.word = match.word;
    span.dataset.reading = match.data.reading || '';
    span.dataset.romaji = match.data.romaji || '';
    span.dataset.english = match.data.english || '';
    span.dataset.type = match.data.type || '';

    // Replace the current text node (which now contains just the matched word) with the span
    parent.replaceChild(span, currentNode);
    span.appendChild(document.createTextNode(match.word));

    // Continue processing from the remaining text after the match
    currentNode = afterNode;
  }
}

/**
 * Highlight known words in a message element using DOM-preserving TreeWalker.
 * Preserves line breaks, links, and other HTML structure.
 * Skips quoted reply blocks.
 * @param {HTMLElement} messageEl - Message element to process
 */
export function highlightKnownWords(messageEl) {
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
