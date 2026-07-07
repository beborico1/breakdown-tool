// Global state for translation tracking

// Minimalistic mode state (default on: original text is kept, words colored
// in-place, and a floating breakdown card appears on hover)
export let minimalisticModeEnabled = true;
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

// Sentence-level processing debounce (wait for speech recognition to settle)
export const SENTENCE_DEBOUNCE_MS = 800;

// Minimalistic-incremental idle flush: when the live caption stops changing for
// this long, the speech engine has stopped revising, so we process the buffered
// tail (last `sentenceStabilityBuffer` sentences + any un-terminated fragment)
// without waiting for a new sentence-ender or a speaker change.
export const MM_SETTLE_MS = 2500;

export const pendingDeltas = new Map();

// Cache translations by content key (survives container replacement)
// Key: `${speaker}|${textHash}|${timeBucket}`
// Value: { translatedText, breakdownData, timestamp, speaker, originalText }
export const translationCache = new Map();

// Text-only breakdown cache (keyed by hashText(text), no time bucket)
// Ensures identical text always produces the same tokenization on re-processing
// Value: { breakdownData, timestamp }
export const breakdownCache = new Map();

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

// Word block font size
export let wordBlockFontSize = 15;
export function setWordBlockFontSize(value) { wordBlockFontSize = value; }

// Sentence chunk size (process every N sentence-ending marks)
export let sentenceChunkSize = 2;
export function setSentenceChunkSize(value) { sentenceChunkSize = value; }

// How many most-recent sentences to leave unprocessed while the speech engine
// may still rewrite them. Minimalistic-incremental only processes sentences
// older than this buffer, so colors don't churn on live captions.
export let sentenceStabilityBuffer = 1;
export function setSentenceStabilityBuffer(value) { sentenceStabilityBuffer = value; }

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

// Session-long transcript accumulator for auto-download on meeting end.
// Entries live in insertion order (order captions first appeared).
// Each entry: { speaker, text, firstSeen, copiedLen? }
// copiedLen is the high-water mark of chars already copied by the "Copy New"
// feature; set lazily by the copy handlers so the next copy picks up only text
// appended since (Meet grows a caption block's text in place). Cleared with the
// array on meeting end, so copy progress resets per meeting.
export const sessionTranscript = [];

// Maps a caption container element to its index in sessionTranscript,
// so later text updates mutate the same entry instead of appending a new one.
export const containerToTranscriptIndex = new WeakMap();

// Transient reattachment buffer for the session transcript. When Meet removes a
// caption's DOM element mid-utterance and swaps in a fresh one, the replacement
// is a new WeakMap key, so recordCaptionToTranscript would push a duplicate entry
// for the same spoken line. On removal we stash the entry's index here; a
// replacement that purely continues the text reattaches to it instead of pushing.
// Entries: { index, text, speaker, removedAt }. Pruned by age; cleared on meeting end.
export const transcriptOrphans = [];

// How long a removed caption stays eligible for reattachment. A DOM swap inserts
// the replacement within the same/adjacent observer callback, so a short window
// catches swaps while avoiding false merges with genuinely later utterances.
export const TRANSCRIPT_REATTACH_WINDOW_MS = 2000;

export function resetSessionTranscript() {
  sessionTranscript.length = 0;
  transcriptOrphans.length = 0;
  // WeakMap entries are released as their container elements are GC'd.
}
