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
  setSentenceStabilityBuffer,
  sessionTranscript,
  resetSessionTranscript
} from '../core/state.js';
import { pruneTranslationCache } from '../core/cache.js';
import { initWordCache } from '../core/word-cache.js';
import { loadMinimalisticMode, removeMinimalisticOverlay } from './minimalistic-mode.js';
import { removeOverlay } from './caption-handler.js';
import { setupCaptionClickHandlers, handleMutations, setObserver } from './dom-fighter.js';
import { extractCaptions, formatCaptions } from './caption-extractor.js';
import { applyWordBlockFontSize } from './panel-mode.js';
import { triggerTranscriptDownload } from './transcript-download.js';
import { initAnkiQuickAdd, attachAnkiContextMenu } from '../chat/anki-quick-add.js';

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
async function initializeObserver() {
  // Word cache powers minimalistic mode's pre-paint and back-fills itself from
  // Meet breakdowns. Load it before the observer so early captions see hits.
  await initWordCache();

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

  // Load sentence stability buffer setting (minimalistic mode: skip last N
  // sentences so the speech engine has time to revise them before we process).
  chrome.storage.sync.get(['sentenceStabilityBuffer'], (result) => {
    if (typeof result.sentenceStabilityBuffer === 'number') {
      setSentenceStabilityBuffer(result.sentenceStabilityBuffer);
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
      debugLog('MEETING-END', 'detected URL change out of meeting');
      resetSessionTranscript();
    }
    lastWasInMeeting = nowInMeeting;
  }, 2000);

  debugLog('SETUP', 'Observer initialized');
}

/**
 * Initialize Google Meet features
 */
export function initializeGoogleMeet() {
  if (location.hostname === 'meet.google.com') {
    initAnkiQuickAdd();
    attachAnkiContextMenu();
  }

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

    if (changes.sentenceStabilityBuffer) {
      const newBuffer = changes.sentenceStabilityBuffer.newValue;
      debugLog('STORAGE', `Sentence stability buffer changed: ${newBuffer}`);
      setSentenceStabilityBuffer(newBuffer);
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
