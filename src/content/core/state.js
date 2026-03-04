// Global state for translation tracking

// Track the last copied index for "Copy New" feature
export let lastCopiedIndex = 0;
export function setLastCopiedIndex(value) {
  lastCopiedIndex = value;
}

// Minimalistic mode state
export let minimalisticModeEnabled = false;
export function setMinimalisticModeEnabled(value) {
  minimalisticModeEnabled = value;
}

// Translation state keyed by container element
// Value: { originalText, originalEl, translatedText, translatedEl, contentKey,
//          lastTranslatedLength, shadowOriginalEl, speakerName, isIncremental,
//          breakdownData, isExpanded,
//          // Minimalistic mode specific:
//          minimalisticState: { processedUpTo, processingUpTo, wordBoundaries, sentenceRanges, processTimer } }
export const translationState = new Map();

// Delta translation debouncing
export const DELTA_DEBOUNCE_MS = 500;
export const pendingDeltas = new Map();

// Cache translations by content key (survives container replacement)
// Key: `${speaker}|${textHash}|${timeBucket}`
// Value: { translatedText, breakdownData, timestamp, speaker, originalText }
export const translationCache = new Map();

// Track which content keys are currently displayed (user hasn't toggled off)
export const activeContentKeys = new Set();

// Cache pruning interval (5 minutes)
export const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

// Word frequency tracking
export const FREQUENCY_SAVE_DEBOUNCE_MS = 2000;
export let frequencySaveTimeout = null;
export function setFrequencySaveTimeout(value) {
  frequencySaveTimeout = value;
}
export const pendingFrequencyUpdates = new Map(); // Accumulate updates before saving
export const countedContentKeys = new Set(); // Track which translations have been counted

// Observer loop detection
export let observerCallCount = 0;
export let observerCallWindowStart = Date.now();
export const OBSERVER_RATE_LIMIT = 50; // max calls per second before warning

export function incrementObserverCallCount() {
  observerCallCount++;
}

export function resetObserverCallCount() {
  observerCallCount = 0;
  observerCallWindowStart = Date.now();
}

export function getObserverCallCount() {
  return observerCallCount;
}

export function getObserverCallWindowStart() {
  return observerCallWindowStart;
}

// API call counter
export let apiCallCount = 0;
export function incrementApiCallCount() {
  return ++apiCallCount;
}

// Observer config (reusable for observe/reconnect)
export const OBSERVER_CONFIG = {
  childList: true,
  subtree: true,
  characterData: true,
};

// Google Chat state
export let activeGcwbOverlay = null;
export let activeGcwbContextMenu = null;
export let overlayCreatedAt = 0;

export function setActiveGcwbOverlay(value) {
  activeGcwbOverlay = value;
}

export function setActiveGcwbContextMenu(value) {
  activeGcwbContextMenu = value;
}

export function setOverlayCreatedAt(value) {
  overlayCreatedAt = value;
}

// Track inline breakdown state per message element
// Value: { originalHTML, breakdownData, isShowingBreakdown, loadingIndicator }
export const inlineBreakdownState = new Map();
