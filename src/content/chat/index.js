import { debugLog } from '../core/debug.js';
import { isGoogleChat, findChatMessageElement, extractChatMessageText } from './message-finder.js';
import { showCustomContextMenu } from './context-menu.js';
import { initWordCache } from '../core/word-cache.js';
import { setupWordTooltip, onIslandChange } from './word-tooltip.js';
import { setupWordIsland } from '../shared/word-island.js';
import { translateClause, warmClauseTranslator, peekClauseTranslation } from '../core/clause-translate.js';
import { maybeAutoAnalyzeChat } from '../core/auto-analyze.js';
import { initAnkiQuickAdd } from './anki-quick-add.js';

// Let a burst of DOM churn settle into one re-highlight pass.
const HIGHLIGHT_DEBOUNCE_MS = 150;

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
  showCustomContextMenu(event, messageEl, text);
}

/**
 * Set up automatic highlighting for new messages using MutationObserver
 */
function setupAutoHighlighting() {
  // Highlight all existing messages
  maybeAutoAnalyzeChat();

  // Watch for new messages
  let highlightTimer = null;
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
      // Coalesce: a burst of mutations (loading a conversation, a run of
      // incoming messages) used to schedule one full re-highlight per batch.
      if (highlightTimer) return;
      highlightTimer = setTimeout(() => {
        highlightTimer = null;
        maybeAutoAnalyzeChat();
      }, HIGHLIGHT_DEBOUNCE_MS);
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

  if (!isGoogleChat()) {
    debugLog('GCWB-INIT', 'Not on Google Chat, skipping');
    return;
  }

  // Initialize word cache from storage (after the host check — loading it on
  // sites that never highlight was a wasted storage read per frame)
  await initWordCache();

  const setup = () => {
    setupChatContextMenu();
    setupAutoHighlighting();
    setupWordTooltip({ translateClause, warmClauseTranslator, peekClauseTranslation });
    setupWordIsland({ onChange: onIslandChange });
    initAnkiQuickAdd();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
}
