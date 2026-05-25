import { debugLog } from '../core/debug.js';
import { isGoogleChat, findChatMessageElement, extractChatMessageText } from './message-finder.js';
import { showCustomContextMenu } from './context-menu.js';
import { initWordCache } from '../core/word-cache.js';
import { highlightKnownWords, highlightAllMessages, clearHighlightState } from './word-highlight.js';
import { setupWordTooltip } from './word-tooltip.js';
import { translateToJapaneseWithGemini } from '../core/api.js';
import { maybeAutoAnalyzeChat, watchOfflineToggle } from '../core/auto-analyze.js';
import { initAnkiQuickAdd } from './anki-quick-add.js';

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
  highlightAllMessages();
  maybeAutoAnalyzeChat();
  watchOfflineToggle(() => maybeAutoAnalyzeChat());

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
        maybeAutoAnalyzeChat();
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

// Cache the last non-empty text selection (popup steals focus and clears window.getSelection())
let cachedSelectionText = '';

// Cache the last focused compose area so translation targets the thread input, not just the first
// contenteditable on the page (popup steals focus, so document.activeElement is unreliable at translate time)
let lastFocusedComposeArea = null;

/**
 * Show a toast notification on the page
 * @param {string} message - Toast message
 * @param {'info'|'success'|'error'} type - Toast type
 * @param {number} duration - Duration in ms
 */
function showToast(message, type = 'info', duration = 3000) {
  // Remove any existing toast
  const existing = document.querySelector('.gcwb-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `gcwb-toast gcwb-toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('gcwb-toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

/**
 * Handle translating the selected text to Japanese and appending it to the compose area
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function handleTranslateToJapanese() {
  // Get selected text, fall back to cached selection
  let selectedText = window.getSelection().toString().trim();
  if (!selectedText) {
    selectedText = cachedSelectionText;
  }

  if (!selectedText) {
    return { success: false, message: 'No text selected' };
  }

  // Prefer the last focused compose area so thread inputs work; fall back to the first one if
  // nothing was focused or the cached reference was detached (e.g., thread panel closed)
  let composeArea = lastFocusedComposeArea;
  if (!composeArea || !composeArea.isConnected) {
    composeArea = document.querySelector('div[contenteditable="true"][role="textbox"]');
  }
  if (!composeArea) {
    return { success: false, message: 'No compose area found' };
  }

  showToast('Translating to Japanese...', 'info');

  try {
    const japaneseText = await translateToJapaneseWithGemini(selectedText);

    // Focus the compose area and move cursor to end
    composeArea.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composeArea);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    // Insert newline + translation
    document.execCommand('insertText', false, '\n' + japaneseText);

    showToast('Translation appended!', 'success');
    return { success: true, message: 'Translation appended' };
  } catch (error) {
    debugLog('TRANSLATE-JP', 'Error:', error.message);
    showToast('Translation failed: ' + error.message, 'error');
    return { success: false, message: error.message };
  }
}

function findEditableHost(node) {
  let el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (el) {
    if (el.matches?.('div[contenteditable="true"][role="textbox"]')) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * Replace the currently selected text with its Japanese translation.
 * Only works when the selection sits inside a contenteditable compose area.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function handleTranslateToJapaneseReplace() {
  const selection = window.getSelection();
  const selectedText = selection.toString().trim();

  // Content script runs in every frame (all_frames: true), so frames without a
  // selection must stay silent — otherwise they toast while a sibling frame succeeds.
  if (!selectedText || selection.rangeCount === 0) {
    return { success: false, message: 'No text selected' };
  }

  const range = selection.getRangeAt(0);
  const editableHost = findEditableHost(range.commonAncestorContainer);

  if (!editableHost) {
    showToast('Select text in your message input to replace', 'error');
    return { success: false, message: 'Selection is not in a compose area' };
  }

  showToast('Translating to Japanese...', 'info');

  try {
    const japaneseText = await translateToJapaneseWithGemini(selectedText);

    editableHost.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, japaneseText);

    showToast('Translation inserted!', 'success');
    return { success: true, message: 'Translation inserted' };
  } catch (error) {
    debugLog('TRANSLATE-JP-REPLACE', 'Error:', error.message);
    showToast('Translation failed: ' + error.message, 'error');
    return { success: false, message: error.message };
  }
}

/**
 * Initialize Google Chat features
 */
export async function initializeGoogleChat() {
  debugLog('GCWB-INIT', `Document readyState: ${document.readyState}`);

  // Initialize word cache from storage
  await initWordCache();

  if (!isGoogleChat()) {
    debugLog('GCWB-INIT', 'Not on Google Chat, skipping');
    return;
  }

  const setup = () => {
    setupChatContextMenu();
    setupAutoHighlighting();
    setupWordTooltip();
    initAnkiQuickAdd();

    // Cache selection text on selection change (popup steals focus)
    document.addEventListener('selectionchange', () => {
      const text = window.getSelection().toString().trim();
      if (text) {
        cachedSelectionText = text;
      }
    });

    // Track the last focused compose area (main channel vs thread input)
    document.addEventListener('focusin', (event) => {
      const target = event.target;
      if (target?.matches?.('div[contenteditable="true"][role="textbox"]')) {
        lastFocusedComposeArea = target;
      }
    });

    // Listen for translate-to-japanese messages from popup or service worker
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'translate-to-japanese') {
        handleTranslateToJapanese().then(sendResponse);
        return true; // async response
      }
      if (message.action === 'translate-to-japanese-replace') {
        handleTranslateToJapaneseReplace().then(sendResponse);
        return true; // async response
      }
    });

    // Re-highlight after inline breakdown is dismissed
    document.addEventListener('gcwb-content-restored', (event) => {
      const messageEl = event.target;
      if (messageEl) {
        clearHighlightState(messageEl);
        highlightKnownWords(messageEl);
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
}
