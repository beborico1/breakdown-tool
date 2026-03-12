import { debugLog } from '../core/debug.js';
import { initWordCache } from '../core/word-cache.js';
import { isRedmine, findRedmineTextElement, extractRedmineText } from './message-finder.js';
import { showCustomContextMenu } from '../chat/context-menu.js';
import { highlightRedmineBlock, highlightAllRedmineBlocks, clearRedmineHighlightState } from './word-highlight.js';
import { setupWordTooltip } from '../chat/word-tooltip.js';


/**
 * Handle right-click on Redmine text blocks
 * @param {MouseEvent} event
 */
function handleRedmineContextMenu(event) {
  debugLog('REDMINE', 'Context menu event triggered on:', event.target.className || event.target.nodeName);

  const textEl = findRedmineTextElement(event.target);
  if (!textEl) {
    debugLog('REDMINE', 'No text element found, letting default menu show');
    return;
  }

  const text = extractRedmineText(textEl);
  debugLog('REDMINE', 'Extracted text:', text?.slice(0, 50) + '...');
  if (!text) {
    debugLog('REDMINE', 'No text found');
    return;
  }

  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
  if (!hasJapanese) {
    debugLog('REDMINE', 'No Japanese text detected');
    return;
  }

  debugLog('REDMINE', 'Japanese detected, showing custom menu');
  event.preventDefault();
  event.stopPropagation();
  showCustomContextMenu(event, textEl, text);
}

/**
 * Set up context menu handler for Redmine
 */
function setupRedmineContextMenu() {
  debugLog('REDMINE', 'Setting up Redmine context menu');
  document.addEventListener('contextmenu', handleRedmineContextMenu, true);
}

/**
 * Initialize Redmine features
 */
export async function initializeRedmine() {
  debugLog('REDMINE-INIT', `Document readyState: ${document.readyState}`);

  // Initialize word cache from storage
  await initWordCache();

  if (!isRedmine()) {
    debugLog('REDMINE-INIT', 'Not on Redmine, skipping initialization');
    return;
  }

  debugLog('REDMINE-INIT', 'Initializing Redmine features');

  const setup = () => {
    setupRedmineContextMenu();
    highlightAllRedmineBlocks();
    setupWordTooltip();

    // Listen for content-restored events to re-highlight after breakdown dismiss
    document.addEventListener('gcwb-content-restored', (event) => {
      const blockEl = event.target;
      if (blockEl) {
        clearRedmineHighlightState(blockEl);
        highlightRedmineBlock(blockEl);
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
}
