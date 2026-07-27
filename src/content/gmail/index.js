import { debugLog } from '../core/debug.js';
import { initWordCache } from '../core/word-cache.js';
import { isGmail, findGmailMessageElement, extractGmailMessageText, extractBrSeparatedLine, filterJapaneseContent, getGmailThreadMessages } from './message-finder.js';
import { showInlineBreakdown } from '../chat/inline-breakdown.js';
import { showCustomContextMenu } from '../chat/context-menu.js';
import { highlightGmailMessage, highlightAllGmailMessages, clearGmailHighlightState } from './word-highlight.js';
import { setupWordTooltip } from '../chat/word-tooltip.js';
import { translateClause, warmClauseTranslator } from '../core/clause-translate.js';
import { maybeAutoAnalyzeGmail } from '../core/auto-analyze.js';

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

  // Focused sub-element → simple textContent; full message → full extraction
  const isFocused = !(messageEl.classList?.contains('a3s') && messageEl.classList?.contains('aiL'));
  let fullText;
  if (isFocused) {
    fullText = messageEl.textContent?.trim() || '';
  } else {
    // Try br-separated line extraction first (plain-text emails like Redmine notifications)
    const lineText = extractBrSeparatedLine(event.target, messageEl);
    if (lineText) {
      fullText = lineText;
      debugLog('GMAIL', 'Using br-separated line text');
    } else {
      fullText = extractGmailMessageText(messageEl);
    }
  }
  debugLog('GMAIL', `Extracted text (focused=${isFocused}):`, fullText?.slice(0, 50) + '...');
  if (!fullText) {
    debugLog('GMAIL', 'No text found');
    return;
  }

  // Check if text contains Japanese characters
  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(fullText);
  if (!hasJapanese) {
    debugLog('GMAIL', 'No Japanese text detected');
    return;
  }

  // Filter to Japanese-only content for analysis
  const filteredText = filterJapaneseContent(fullText) || fullText;

  // Check if thread has multiple messages with Japanese
  const threadMessages = getGmailThreadMessages();
  const options = {};
  if (threadMessages.length >= 2) {
    options.analyzeThread = () => analyzeThread(threadMessages);
  }

  debugLog('GMAIL', 'Japanese detected, showing custom menu');
  event.preventDefault();
  event.stopPropagation();
  showCustomContextMenu(event, messageEl, filteredText, options);
}

/**
 * Analyze all Japanese messages in the Gmail thread
 * @param {Array<{messageEl: HTMLElement, text: string}>} threadMessages
 */
function analyzeThread(threadMessages) {
  debugLog('GMAIL', `Analyzing thread: ${threadMessages.length} messages`);
  for (const { messageEl, text } of threadMessages) {
    showInlineBreakdown(messageEl, text);
  }
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
      maybeAutoAnalyzeGmail();
    }, 500);
  });
}

/**
 * Initialize Gmail features
 */
export async function initializeGmail() {
  debugLog('GMAIL-INIT', `Document readyState: ${document.readyState}`);

  if (!isGmail()) {
    debugLog('GMAIL-INIT', 'Not on Gmail, skipping initialization');
    return;
  }

  debugLog('GMAIL-INIT', 'Initializing Gmail features');

  // Initialize word cache from storage (after the host check — loading it on
  // sites that never highlight was a wasted storage read per frame)
  await initWordCache();

  const setup = () => {
    setupGmailContextMenu();
    setupGmailAutoHighlighting();
    setupWordTooltip({ translateClause, warmClauseTranslator });
    setupGmailNavigationWatcher();
    maybeAutoAnalyzeGmail();

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
