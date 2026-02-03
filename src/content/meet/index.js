import { debugLog } from '../core/debug.js';
import {
  OBSERVER_CONFIG,
  minimalisticModeEnabled,
  setMinimalisticModeEnabled,
  translationState,
  setLastCopiedIndex,
  lastCopiedIndex
} from '../core/state.js';
import { pruneTranslationCache } from '../core/cache.js';
import { loadMinimalisticMode, removeMinimalisticOverlay } from './minimalistic-mode.js';
import { removeOverlay } from './caption-handler.js';
import { setupCaptionClickHandlers, handleMutations, setObserver } from './dom-fighter.js';
import { extractCaptions, formatCaptions } from './caption-extractor.js';

// Create the MutationObserver
const observer = new MutationObserver((mutations) => {
  handleMutations(mutations, OBSERVER_CONFIG);
});

// Set observer reference for dom-fighter
setObserver(observer);

/**
 * Initialize the observer when the page loads
 */
function initializeObserver() {
  observer.observe(document.body, OBSERVER_CONFIG);
  // Initial setup
  setupCaptionClickHandlers();

  // Load minimalistic mode setting
  loadMinimalisticMode();

  // Prune translation cache periodically (every minute)
  setInterval(pruneTranslationCache, 60 * 1000);

  debugLog('SETUP', 'Observer initialized');
}

/**
 * Initialize Google Meet features
 */
export function initializeGoogleMeet() {
  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeObserver);
  } else {
    initializeObserver();
  }

  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'copyAll') {
      const captions = extractCaptions();

      if (captions.length === 0) {
        sendResponse({ success: false, message: 'No captions found', text: null });
        return;
      }

      const formatted = formatCaptions(captions);
      setLastCopiedIndex(captions.length);
      sendResponse({
        success: true,
        message: `Copied ${captions.length} caption(s)`,
        text: formatted
      });
      return;
    }

    if (request.action === 'copyNew') {
      const captions = extractCaptions();
      const newCaptions = captions.slice(lastCopiedIndex);

      if (newCaptions.length === 0) {
        sendResponse({ success: false, message: 'No new captions since last copy', text: null });
        return;
      }

      const formatted = formatCaptions(newCaptions);
      setLastCopiedIndex(captions.length);
      sendResponse({
        success: true,
        message: `Copied ${newCaptions.length} new caption(s)`,
        text: formatted
      });
      return;
    }
  });

  // Listen for storage changes (minimalistic mode toggle)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;

    if (changes.minimalisticModeEnabled) {
      const newValue = changes.minimalisticModeEnabled.newValue;
      const oldValue = changes.minimalisticModeEnabled.oldValue;

      debugLog('STORAGE', `Minimalistic mode changed: ${oldValue} -> ${newValue}`);
      setMinimalisticModeEnabled(newValue);

      // When mode changes, we need to clean up existing overlays and re-apply
      // This ensures smooth transition between modes
      if (newValue !== oldValue) {
        // Clean up all existing translation overlays
        for (const [container, state] of translationState) {
          if (state.minimalisticState) {
            removeMinimalisticOverlay(container);
          } else {
            removeOverlay(container);
          }
        }
        debugLog('STORAGE', 'Cleaned up existing overlays for mode switch');
      }
    }
  });
}
