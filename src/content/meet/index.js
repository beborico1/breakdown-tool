import { debugLog } from '../core/debug.js';
import {
  OBSERVER_CONFIG,
  minimalisticModeEnabled,
  setMinimalisticModeEnabled,
  translationState,
  setLastCopiedIndex,
  lastCopiedIndex,
  setWordBlockFontSize,
  wordBlockFontSize,
  setSentenceChunkSize,
  sessionTranscript,
  resetSessionTranscript
} from '../core/state.js';
import { pruneTranslationCache } from '../core/cache.js';
import { loadMinimalisticMode, removeMinimalisticOverlay } from './minimalistic-mode.js';
import { removeOverlay } from './caption-handler.js';
import { setupCaptionClickHandlers, handleMutations, setObserver } from './dom-fighter.js';
import { extractCaptions, formatCaptions } from './caption-extractor.js';
import { applyWordBlockFontSize } from './panel-mode.js';
import { triggerTranscriptDownload } from './transcript-download.js';

// Google Meet room URLs look like /xxx-yyyy-zzz. When we transition out
// of one, the user has left the meeting — that's our auto-download signal.
const MEETING_PATH_RE = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\b/;

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

  // Load word block font size setting
  chrome.storage.sync.get(['wordBlockFontSize'], (result) => {
    if (result.wordBlockFontSize) {
      setWordBlockFontSize(result.wordBlockFontSize);
      applyWordBlockFontSize(result.wordBlockFontSize);
    }
  });

  // Load sentence chunk size setting
  chrome.storage.sync.get(['sentenceChunkSize'], (result) => {
    if (result.sentenceChunkSize) {
      setSentenceChunkSize(result.sentenceChunkSize);
    }
  });

  // Prune translation cache periodically (every minute)
  setInterval(pruneTranslationCache, 60 * 1000);

  // Watch for SPA navigation away from the meeting room — fires when the
  // user clicks "Leave call" and Meet swaps the URL to the landing page.
  let lastWasInMeeting = MEETING_PATH_RE.test(location.pathname);
  setInterval(() => {
    const nowInMeeting = MEETING_PATH_RE.test(location.pathname);
    if (lastWasInMeeting && !nowInMeeting) {
      debugLog('MEETING-END', 'detected URL change out of meeting, auto-downloading transcript');
      triggerTranscriptDownload({ reason: 'url-change' });
      resetSessionTranscript();
    }
    lastWasInMeeting = nowInMeeting;
  }, 2000);

  // Best-effort fallback for tab close / full page navigation. Chrome may
  // cancel the download if the document is tearing down too fast — the
  // popup's manual button is the guaranteed path for that case.
  window.addEventListener('beforeunload', () => {
    if (MEETING_PATH_RE.test(location.pathname) && sessionTranscript.length > 0) {
      triggerTranscriptDownload({ reason: 'beforeunload' });
    }
  });

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

    if (request.action === 'downloadTranscript') {
      const started = triggerTranscriptDownload({ reason: 'manual' });
      if (started) {
        sendResponse({
          success: true,
          message: `Downloading ${sessionTranscript.length} caption(s)`
        });
      } else {
        sendResponse({
          success: false,
          message: 'No captions captured yet in this meeting'
        });
      }
      return;
    }
  });

  // Listen for storage changes (minimalistic mode toggle)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;

    if (changes.wordBlockFontSize) {
      const newSize = changes.wordBlockFontSize.newValue;
      debugLog('STORAGE', `Word block font size changed: ${newSize}`);
      setWordBlockFontSize(newSize);
      applyWordBlockFontSize(newSize);
    }

    if (changes.sentenceChunkSize) {
      const newSize = changes.sentenceChunkSize.newValue;
      debugLog('STORAGE', `Sentence chunk size changed: ${newSize}`);
      setSentenceChunkSize(newSize);
    }

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
