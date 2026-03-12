/**
 * Audio Mode Content Script
 * Receives audio segments from the service worker, transcribes via Gemini,
 * and renders word breakdowns in the floating panel.
 */

import { analyzeAudioWithGemini } from '../core/api.js';
import { createPanel, addSegment, showProcessing, removePanel } from './floating-panel.js';

let isProcessing = false;
const segmentQueue = [];

/**
 * Initialize audio mode on this page
 */
function init() {
  // Create the floating panel
  createPanel();

  // Listen for messages from service worker
  chrome.runtime.onMessage.addListener(onMessage);
}

/**
 * Handle messages from the service worker
 */
function onMessage(message) {
  if (message.type === 'audio-segment') {
    segmentQueue.push({
      audio: message.audio,
      mimeType: message.mimeType
    });
    processQueue();
  }

  if (message.type === 'audio-mode-stopped') {
    cleanup();
  }
}

/**
 * Process queued audio segments one at a time
 */
async function processQueue() {
  if (isProcessing || segmentQueue.length === 0) return;

  isProcessing = true;
  const segment = segmentQueue.shift();

  try {
    showProcessing();

    const result = await analyzeAudioWithGemini(segment.audio, segment.mimeType);

    // Skip if no Japanese speech detected or empty result
    if (result && result.words && result.words.length > 0) {
      addSegment(result);
    }
  } catch (error) {
    console.error('[AudioMode] Transcription error:', error);
    // Don't show error for every failed segment - just skip
  }

  isProcessing = false;

  // Process next in queue
  if (segmentQueue.length > 0) {
    processQueue();
  }
}

/**
 * Clean up audio mode
 */
function cleanup() {
  segmentQueue.length = 0;
  isProcessing = false;
  removePanel();
  chrome.runtime.onMessage.removeListener(onMessage);
}

// Initialize immediately when injected
init();
