import { debugLog } from '../core/debug.js';
import { initWordCache } from '../core/word-cache.js';
import { isGmail, findGmailMessageElement, extractGmailMessageText } from './message-finder.js';
import { showCustomContextMenu } from '../chat/context-menu.js';
import { highlightGmailMessage, highlightAllGmailMessages, clearGmailHighlightState } from './word-highlight.js';
import { setupWordTooltip } from '../chat/word-tooltip.js';

/**
 * Handle right-click on Gmail message bodies
 * @param {MouseEvent} event - Context menu event
 */
function handleGmailContextMenu(event) {
  debugLog('GMAIL', 'Context menu event triggered on:', event.target.className || event.target.nodeName);

  const messageEl = findGmailMessageElement(event.target);
  if (!messageEl) {
    debugLog('GMAIL', 'No message element found, letting default menu show');
    return;
  }

  const text = extractGmailMessageText(messageEl);
  debugLog('GMAIL', 'Extracted text:', text?.slice(0, 50) + '...');
  if (!text) {
    debugLog('GMAIL', 'No text found');
    return;
  }

  // Check if text contains Japanese characters
  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
  if (!hasJapanese) {
    debugLog('GMAIL', 'No Japanese text detected');
    return;
  }

  debugLog('GMAIL', 'Japanese detected, showing custom menu');
  event.preventDefault();
  event.stopPropagation();
  showCustomContextMenu(event, messageEl, text);
}

/**
 * Set up context menu handler for Gmail
 */
function setupGmailContextMenu() {
  debugLog('GMAIL', 'Setting up Gmail context menu');
  document.addEventListener('contextmenu', handleGmailContextMenu, true);
}

/**
 * Set up automatic highlighting for Gmail messages using MutationObserver
 */
function setupGmailAutoHighlighting() {
  // Highlight all existing messages
  highlightAllGmailMessages();

  let debounceTimer = null;

  // Watch for new messages (thread expansion, navigation)
  const observer = new MutationObserver((mutations) => {
    let shouldHighlight = false;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Check if this is or contains a message body
          if ((node.classList?.contains('a3s') && node.classList?.contains('aiL')) ||
              node.querySelector?.('.a3s.aiL') ||
              (node.classList?.contains('adn') && node.classList?.contains('ads')) ||
              node.querySelector?.('.adn.ads')) {
            shouldHighlight = true;
            break;
          }
        }
      }
      if (shouldHighlight) break;
    }

    if (shouldHighlight) {
      // Debounce to avoid excessive re-highlighting
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        highlightAllGmailMessages();
      }, 150);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  debugLog('GMAIL', 'Auto-highlighting set up with MutationObserver');
}

/**
 * Watch for Gmail SPA navigation (hash changes)
 */
function setupGmailNavigationWatcher() {
  window.addEventListener('hashchange', () => {
    debugLog('GMAIL', 'Hash changed, re-highlighting after delay');
    setTimeout(() => {
      highlightAllGmailMessages();
    }, 500);
  });
}

/**
 * Initialize Gmail features
 */
export async function initializeGmail() {
  debugLog('GMAIL-INIT', `Document readyState: ${document.readyState}`);

  // Initialize word cache from storage
  await initWordCache();

  if (!isGmail()) {
    debugLog('GMAIL-INIT', 'Not on Gmail, skipping initialization');
    return;
  }

  debugLog('GMAIL-INIT', 'Initializing Gmail features');

  const setup = () => {
    setupGmailContextMenu();
    setupGmailAutoHighlighting();
    setupWordTooltip();
    setupGmailNavigationWatcher();

    // Listen for content-restored events from inline-breakdown
    document.addEventListener('gcwb-content-restored', (event) => {
      const messageEl = event.target;
      if (messageEl?.closest('.a3s.aiL') || (messageEl?.classList?.contains('a3s') && messageEl?.classList?.contains('aiL'))) {
        clearGmailHighlightState(messageEl);
        highlightGmailMessage(messageEl);
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
}
