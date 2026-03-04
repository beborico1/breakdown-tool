import { debugLog } from '../core/debug.js';
import { getCachedWords } from '../core/word-cache.js';
import { inlineBreakdownState } from '../core/state.js';
import { getWordTypeClass } from '../utils/text.js';
import { findChatMessageElement } from './message-finder.js';

/**
 * Word Highlight Module
 * Highlights known Japanese words in chat messages automatically
 */

// Track highlighted messages to avoid re-processing
const highlightedMessages = new WeakMap();

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Highlight known words in a message element
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

  // Get raw text content
  const text = messageEl.textContent?.trim() || '';
  if (!text) return;

  // Check for Japanese characters
  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
  if (!hasJapanese) return;

  // Find cached words in the text
  const matches = getCachedWords(text);
  if (matches.length === 0) {
    debugLog('WORD-HIGHLIGHT', 'No cached words found in message');
    return;
  }

  debugLog('WORD-HIGHLIGHT', `Found ${matches.length} cached words`);

  // Build highlighted HTML
  let result = '';
  let lastEnd = 0;

  for (const match of matches) {
    // Add text before this match
    if (match.start > lastEnd) {
      result += escapeHtml(text.slice(lastEnd, match.start));
    }

    // Add highlighted word with data attributes for tooltip
    const typeClass = getWordTypeClass(match.data.type);
    result += `<span class="gcwb-cached-word gcwb-type-${typeClass}"
      data-word="${escapeHtml(match.word)}"
      data-reading="${escapeHtml(match.data.reading || '')}"
      data-romaji="${escapeHtml(match.data.romaji || '')}"
      data-english="${escapeHtml(match.data.english || '')}"
      data-type="${escapeHtml(match.data.type || '')}">${escapeHtml(match.word)}</span>`;

    lastEnd = match.end;
  }

  // Add remaining text
  if (lastEnd < text.length) {
    result += escapeHtml(text.slice(lastEnd));
  }

  // Save original HTML and apply highlighting
  highlightedMessages.set(messageEl, {
    originalHTML: messageEl.innerHTML,
    highlightedHTML: result
  });

  messageEl.innerHTML = result;
}

/**
 * Highlight all visible messages that contain Japanese text
 */
export function highlightAllMessages() {
  // Find all message text elements (.Zc1Emd is the message text container)
  const messageTextElements = document.querySelectorAll('.Zc1Emd');
  let highlightedCount = 0;

  messageTextElements.forEach((textEl) => {
    const messageEl = findChatMessageElement(textEl);
    if (messageEl) {
      const text = messageEl.textContent?.trim() || '';
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
