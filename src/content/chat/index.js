import { debugLog } from '../core/debug.js';
import { isGoogleChat, findChatMessageElement, extractChatMessageText } from './message-finder.js';
import { showCustomContextMenu } from './context-menu.js';
import { initWordCache } from '../core/word-cache.js';
import { highlightKnownWords, highlightAllMessages } from './word-highlight.js';
import { setupWordTooltip } from './word-tooltip.js';

/**
 * Handle right-click on Google Chat messages
 * @param {MouseEvent} event - Context menu event
 */
function handleChatContextMenu(event) {
  debugLog('GCWB', 'Context menu event triggered on:', event.target.className || event.target.nodeName);

  const messageEl = findChatMessageElement(event.target);
  if (!messageEl) {
    debugLog('GCWB', 'No message element found, letting default menu show');
    return;
  }

  const text = extractChatMessageText(messageEl);
  debugLog('GCWB', 'Extracted text:', text?.slice(0, 50) + '...');
  if (!text) {
    debugLog('GCWB', 'No text found');
    return;
  }

  // Check if text contains Japanese characters
  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
  if (!hasJapanese) {
    debugLog('GCWB', 'No Japanese text detected');
    return;
  }

  debugLog('GCWB', 'Japanese detected, showing custom menu');
  // Prevent default context menu and show our custom one
  event.preventDefault();
  event.stopPropagation();
  showCustomContextMenu(event, messageEl);
}

/**
 * Set up automatic highlighting for new messages using MutationObserver
 */
function setupAutoHighlighting() {
  // Highlight all existing messages
  highlightAllMessages();

  // Watch for new messages
  const observer = new MutationObserver((mutations) => {
    let shouldHighlight = false;

    for (const mutation of mutations) {
      // Check added nodes for message elements
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Check if this is a message element or contains message elements
          if (node.classList?.contains('Zc1Emd') || node.querySelector?.('.Zc1Emd')) {
            shouldHighlight = true;
            break;
          }
        }
      }
      if (shouldHighlight) break;
    }

    if (shouldHighlight) {
      // Small delay to let DOM settle
      setTimeout(() => {
        highlightAllMessages();
      }, 50);
    }
  });

  // Observe the entire document for changes
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  debugLog('GCWB', 'Auto-highlighting set up with MutationObserver');
}

/**
 * Set up context menu handler for Google Chat
 */
export function setupChatContextMenu() {
  const isChat = isGoogleChat();
  debugLog('GCWB', `isGoogleChat: ${isChat}, hostname: ${window.location.hostname}, pathname: ${window.location.pathname}`);

  if (!isChat) {
    debugLog('GCWB', 'Not on Google Chat, skipping context menu setup');
    return;
  }

  debugLog('GCWB', 'Setting up Google Chat context menu');
  document.addEventListener('contextmenu', handleChatContextMenu, true);
}

/**
 * Initialize Google Chat features
 */
export async function initializeGoogleChat() {
  debugLog('GCWB-INIT', `Document readyState: ${document.readyState}`);

  // Initialize word cache from storage
  await initWordCache();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupChatContextMenu();
      setupAutoHighlighting();
      setupWordTooltip();
    });
  } else {
    setupChatContextMenu();
    setupAutoHighlighting();
    setupWordTooltip();
  }
}
