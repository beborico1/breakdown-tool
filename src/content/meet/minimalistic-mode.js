import { debugLog } from '../core/debug.js';
import {
  minimalisticModeEnabled,
  setMinimalisticModeEnabled,
  translationState,
  translationCache,
  activeContentKeys,
  SENTENCE_DEBOUNCE_MS,
  MM_SETTLE_MS,
  sentenceStabilityBuffer
} from '../core/state.js';
import { findCachedTranslation, generateContentKey, getTimeBucket, cacheBreakdown } from '../core/cache.js';
import { analyzeJapanese } from '../core/api.js';
import { recordWordFrequencies } from '../services/frequency-tracker.js';
import { cacheWords, getCachedWordBreakdown } from '../core/word-cache.js';
import { attachHoverListeners, detachHoverListeners } from './hover-card.js';
import { paintWordColoring, buildWordBoundaries } from '../shared/word-render.js';

export { paintWordColoring, buildWordBoundaries };

const SENTENCE_ENDERS = /[。！？]/;

// Bounded retries for a sentence whose analysis throws (offscreen doc reaped,
// fetch timeout, transient NLP failure) so it isn't permanently skipped (gray).
const MM_MAX_SENTENCE_ATTEMPTS = 3;

/**
 * Load minimalistic mode setting from storage. Default is ON — users who
 * have never interacted with the (hidden) toggle get the new behavior.
 */
export function loadMinimalisticMode() {
  chrome.storage.sync.get(['minimalisticModeEnabled'], (result) => {
    setMinimalisticModeEnabled(result.minimalisticModeEnabled ?? true);
    debugLog('MM-INIT', `Minimalistic mode: ${minimalisticModeEnabled}`);
  });
}

/**
 * Entry point called from auto-processor when a previous caption is ready to
 * be analyzed. Keeps the original element visible, paints words in-place,
 * and attaches hover listeners for the floating breakdown card.
 */
export async function initializeMinimalisticContainer(container, messageEl, text, speaker) {
  debugLog('MM-INIT', `Initializing: "${text.slice(0, 40)}..."`);

  container.setAttribute('data-mm-active', 'true');
  // Mark upfront so the fight-back loop in dom-fighter doesn't remove the
  // element while we're waiting on the analyzer. The marker stays across paint.
  messageEl.setAttribute('data-mm-colored', 'true');

  const contentKey = generateContentKey(speaker, text, getTimeBucket());

  // Track state so dom-fighter's re-association + mutation handling knows
  // this container is in minimalistic mode.
  translationState.set(container, {
    originalText: text,
    originalEl: messageEl.cloneNode(true),
    translatedText: null,
    translatedEl: null,
    contentKey,
    lastTranslatedLength: text.length,
    shadowOriginalEl: messageEl,
    speakerName: speaker,
    isIncremental: false,
    breakdownData: null,
    isExpanded: true,
    minimalisticState: true,
  });
  activeContentKeys.add(contentKey);

  // Fast path: cached breakdown from a prior identical caption.
  const cached = findCachedTranslation(speaker, text);
  if (cached?.breakdownData) {
    debugLog('MM-CACHE', 'Using cached breakdown');
    applyBreakdown(container, messageEl, text, cached.breakdownData, speaker);
    return;
  }

  // Pre-paint known words from the persistent word cache before the analyzer returns.
  // Cached words were sourced from the same pipeline, so the full-breakdown
  // repaint below renders identical spans for them — no flicker, just early color.
  const preWords = getCachedWordBreakdown(text);
  if (preWords.length > 0) {
    debugLog('MM-PRECACHE', `Pre-painting ${preWords.length} cached word(s)`);
    paintWordColoring(messageEl, text, preWords);
    attachHoverListeners(container, { words: preWords });
  }

  try {
    const breakdownData = await analyzeJapanese(text);

    // Container may have been removed or toggled off while analysis was in flight.
    if (!translationState.has(container)) {
      debugLog('MM-API', 'State dropped during analysis, discarding');
      return;
    }

    translationCache.set(contentKey, {
      translatedText: breakdownData.translation,
      breakdownData,
      timestamp: Date.now(),
      speaker,
      originalText: text,
    });
    cacheBreakdown(text, breakdownData);

    applyBreakdown(container, messageEl, text, breakdownData, speaker);
  } catch (error) {
    debugLog('MM-API', 'Error:', error.message);
    // If we pre-painted from the word cache, keep those colored spans as a
    // graceful degradation. Only tear down when there's nothing useful to show.
    if (preWords.length === 0) {
      removeMinimalisticOverlay(container);
    }
  }
}

function applyBreakdown(container, messageEl, text, breakdownData, speaker) {
  const state = translationState.get(container);
  if (!state) return;

  state.breakdownData = breakdownData;
  state.translatedText = breakdownData.translation;

  // `text` is required: buildScopedBoundaries re-anchors each sentence by
  // searching for its own text, and drops any record that carries none.
  const syntheticSentences = [{
    text,
    startIndex: 0,
    endIndex: text.length,
    breakdownData,
  }];
  paintWordColoring(messageEl, text, breakdownData.words, syntheticSentences);
  attachHoverListeners(container, breakdownData);

  if (state.contentKey && breakdownData.words) {
    recordWordFrequencies(breakdownData.words, state.contentKey);
    cacheWords(breakdownData.words);
  }

  debugLog('MM-APPLY', `Painted ${breakdownData.words.length} words`);
}

/**
 * Tear down minimalistic state for a container. Used when the container is
 * removed from the DOM or when the mode is disabled via storage.
 */
export function removeMinimalisticOverlay(container) {
  const state = translationState.get(container);

  // Cancel pending incremental timers so they don't fire against a torn-down container.
  const ms = state?.minimalisticIncrementalState;
  if (ms?.debounceTimer) clearTimeout(ms.debounceTimer);
  if (ms?.settleTimer) clearTimeout(ms.settleTimer);

  container.removeAttribute('data-mm-active');
  detachHoverListeners(container);

  if (state?.shadowOriginalEl) {
    const el = state.shadowOriginalEl;
    if (el.hasAttribute('data-mm-colored')) {
      el.removeAttribute('data-mm-colored');
      // Restore the plain text we replaced — keeps the DOM clean if the user
      // toggles off while captions are still on screen.
      if (state.originalText) {
        el.textContent = state.originalText;
      }
    }
  }

  if (state?.contentKey) {
    activeContentKeys.delete(state.contentKey);
  }

  translationState.delete(container);
  debugLog('MM-REMOVE', 'Minimalistic overlay removed');
}

/**
 * Initialize eager sentence-by-sentence processing on the *live* caption
 * container while minimalistic mode is on. Unlike initializeMinimalisticContainer
 * (which runs once on a finalized previous card), this keeps accumulating
 * processed sentences as the speaker talks and repaints in place each time a
 * new 。/！/？ closes a sentence.
 */
export function initializeMinimalisticIncremental(container) {
  if (translationState.has(container)) return;

  const messageEl = container.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original]):not([data-mm-colored])');
  if (!messageEl) return;

  const nameEl = container.querySelector('.NWpY1d');
  const speaker = nameEl?.textContent?.trim() || '(unknown)';
  const initialText = messageEl.textContent?.trim() || '';

  debugLog('MM-INC-INIT', `speaker="${speaker}", text="${initialText.slice(0, 40)}..."`);

  // data-shadow-original routes characterData mutations to our handler via
  // dom-fighter's existing path. data-mm-colored marks the element as "ours"
  // so the fight-back loop doesn't strip it. We do NOT hide the element —
  // minimalistic mode paints colored spans in place over the live caption.
  messageEl.setAttribute('data-shadow-original', 'true');
  messageEl.setAttribute('data-mm-colored', 'true');
  container.setAttribute('data-mm-active', 'true');

  const contentKey = generateContentKey(speaker, initialText || 'mm-inc-init', getTimeBucket());

  const minimalisticIncrementalState = {
    fullText: initialText,
    lastProcessedIndex: 0,
    aggregateWords: [],
    aggregateTranslations: [],
    processedSentences: [],
    processingQueue: [],
    isProcessing: false,
    debounceTimer: null,
    settleTimer: null,
  };

  const originalEl = messageEl.cloneNode(true);
  originalEl.style.cssText = '';
  originalEl.removeAttribute('data-shadow-original');
  originalEl.removeAttribute('data-mm-colored');

  translationState.set(container, {
    originalText: initialText,
    originalEl,
    translatedText: null,
    translatedEl: null,
    contentKey,
    lastTranslatedLength: 0,
    shadowOriginalEl: messageEl,
    speakerName: speaker,
    isIncremental: false,
    breakdownData: null,
    isExpanded: true,
    minimalisticIncrementalState,
  });

  activeContentKeys.add(contentKey);

  // A container may already contain a finished sentence on first observation
  // (e.g. we attached mid-way). Kick off one scan to pick that up.
  scanIncrementalSentenceEnders(container);
}

/**
 * Called from dom-fighter on characterData mutations against the live
 * shadow-original element. Re-reads text from the DOM and triggers a
 * debounced sentence scan.
 */
export function handleMinimalisticIncrementalUpdate(container) {
  const state = translationState.get(container);
  const ms = state?.minimalisticIncrementalState;
  if (!ms || !state.shadowOriginalEl) return;

  const newText = state.shadowOriginalEl.textContent?.trim() || '';
  if (newText === ms.fullText) return;

  debugLog('MM-INC-UPDATE', `"${newText.slice(0, 60)}..." (len=${newText.length})`);
  ms.fullText = newText;
  state.originalText = newText;

  // If Meet's speech engine revised an already-processed sentence, drop it (and
  // any later ones) and roll back so the corrected text gets re-analyzed instead
  // of failing to re-anchor and staying gray forever.
  reconcileProcessedSentences(ms);

  // Repaint the processed prefix, coalesced to one paint per frame.
  scheduleRepaintIncremental(container);

  scanIncrementalSentenceEnders(container);

  // Mop up the buffered tail (the last `sentenceStabilityBuffer` sentences plus
  // any un-terminated fragment) once the caption goes quiet — i.e. the speaker
  // paused, so the engine has stopped revising — without waiting for a new
  // sentence-ender or a speaker change.
  if (ms.settleTimer) clearTimeout(ms.settleTimer);
  ms.settleTimer = setTimeout(() => flushSettledTail(container), MM_SETTLE_MS);
}

/**
 * Drop processed sentences whose stored text no longer appears in the current
 * live text (Meet revised them) along with every later sentence, then roll
 * `lastProcessedIndex` back to the end of the last still-valid sentence so the
 * normal scan re-queues and re-analyzes the corrected region.
 */
function reconcileProcessedSentences(ms) {
  if (ms.processedSentences.length === 0) return;

  const text = ms.fullText;
  let cursor = 0;
  let kept = 0;
  for (const sent of ms.processedSentences) {
    const at = text.indexOf(sent.text, cursor);
    if (at === -1) break;
    cursor = at + sent.text.length;
    kept++;
  }

  if (kept === ms.processedSentences.length) return; // everything still anchors

  const dropped = ms.processedSentences.length - kept;
  const survivors = ms.processedSentences.slice(0, kept);
  ms.processedSentences = survivors;
  ms.aggregateWords = survivors.flatMap(s => s.breakdownData?.words || []);
  ms.aggregateTranslations = survivors.map(s => s.breakdownData?.translation).filter(Boolean);
  ms.lastProcessedIndex = cursor;
  debugLog('MM-INC-RECONCILE', `Dropped ${dropped} revised sentence(s); reprocessing from idx=${cursor}`);
}

// Coalesce per-keystroke repaints to one paint per animation frame.
// repaintIncremental rebuilds the whole caption's innerHTML, and characterData
// mutations can fire many times per second on a long turn — without coalescing,
// the per-keystroke O(n) repaint compounds into a late-session freeze.
const pendingRepaints = new Set();
let repaintRaf = 0;

function scheduleRepaintIncremental(container) {
  if (typeof requestAnimationFrame !== 'function') {
    repaintIncremental(container);
    return;
  }
  pendingRepaints.add(container);
  if (repaintRaf) return;
  repaintRaf = requestAnimationFrame(() => {
    repaintRaf = 0;
    const containers = [...pendingRepaints];
    pendingRepaints.clear();
    for (const c of containers) {
      if (translationState.has(c)) repaintIncremental(c);
    }
  });
}

/**
 * Flush the unprocessed tail when the live caption has been quiet for MM_SETTLE_MS.
 * Mirrors finalize but keeps the container live, so a paused (not yet finished)
 * speaker's last sentence colors without waiting for a speaker change.
 */
function flushSettledTail(container) {
  const state = translationState.get(container);
  const ms = state?.minimalisticIncrementalState;
  if (!ms || !state.shadowOriginalEl) return;
  ms.settleTimer = null;

  const currentText = state.shadowOriginalEl.textContent?.trim() || ms.fullText;
  ms.fullText = currentText;
  state.originalText = currentText;

  const remaining = currentText.slice(ms.lastProcessedIndex).trim();
  if (remaining.length === 0) return;

  ms.processingQueue.push({
    text: remaining,
    startIndex: ms.lastProcessedIndex,
    endIndex: currentText.length,
  });
  ms.lastProcessedIndex = currentText.length;
  debugLog('MM-INC-SETTLE', `Flushing settled tail: "${remaining.slice(0, 60)}"`);
  processIncrementalQueue(container);
}

function scanIncrementalSentenceEnders(container) {
  const state = translationState.get(container);
  const ms = state?.minimalisticIncrementalState;
  if (!ms) return;

  const text = ms.fullText;

  // Need at least (buffer + 1) enders past the processed prefix before any
  // sentence is considered "safe" — the most-recent buffer sentences are left
  // alone so Meet's speech engine can still revise them.
  let enderCount = 0;
  for (let i = ms.lastProcessedIndex; i < text.length; i++) {
    if (SENTENCE_ENDERS.test(text[i])) enderCount++;
  }
  if (enderCount <= sentenceStabilityBuffer) return;

  if (ms.debounceTimer) clearTimeout(ms.debounceTimer);
  ms.debounceTimer = setTimeout(() => {
    ms.debounceTimer = null;
    if (!translationState.has(container)) return;

    // Re-read after debounce — speech recognition may have corrected the tail.
    const currentText = state.shadowOriginalEl?.textContent?.trim() || '';
    ms.fullText = currentText;
    state.originalText = currentText;

    // Collect every ender past the cursor, then pick the one that leaves
    // `sentenceStabilityBuffer` enders behind it untouched.
    const enders = [];
    for (let i = ms.lastProcessedIndex; i < currentText.length; i++) {
      if (SENTENCE_ENDERS.test(currentText[i])) enders.push(i);
    }
    if (enders.length <= sentenceStabilityBuffer) return;

    const targetEnderIdx = enders[enders.length - 1 - sentenceStabilityBuffer];

    const chunkText = currentText.slice(ms.lastProcessedIndex, targetEnderIdx + 1).trim();
    if (chunkText.length > 0) {
      ms.processingQueue.push({
        text: chunkText,
        startIndex: ms.lastProcessedIndex,
        endIndex: targetEnderIdx + 1,
      });
      debugLog('MM-INC-QUEUE', `"${chunkText.slice(0, 60)}" (buffer=${sentenceStabilityBuffer}, enders=${enders.length})`);
    }
    ms.lastProcessedIndex = targetEnderIdx + 1;

    processIncrementalQueue(container);
  }, SENTENCE_DEBOUNCE_MS);
}

async function processIncrementalQueue(container) {
  const state = translationState.get(container);
  const ms = state?.minimalisticIncrementalState;
  if (!ms) return;
  if (ms.isProcessing) return;
  if (ms.processingQueue.length === 0) return;

  ms.isProcessing = true;

  while (ms.processingQueue.length > 0) {
    if (!translationState.has(container)) { ms.isProcessing = false; return; }
    const sentence = ms.processingQueue.shift();

    debugLog('MM-INC-PROCESS', `"${sentence.text.slice(0, 40)}"`);

    try {
      const cached = findCachedTranslation(state.speakerName, sentence.text);
      const breakdownData = cached?.breakdownData
        ? cached.breakdownData
        : await analyzeJapanese(sentence.text);

      if (!translationState.has(container)) { ms.isProcessing = false; return; }

      if (Array.isArray(breakdownData.words)) {
        ms.aggregateWords.push(...breakdownData.words);
      }
      if (breakdownData.translation) {
        ms.aggregateTranslations.push(breakdownData.translation);
      }
      ms.processedSentences.push({
        text: sentence.text,
        breakdownData,
        startIndex: sentence.startIndex,
        endIndex: sentence.endIndex,
      });

      const sentenceKey = generateContentKey(state.speakerName, sentence.text, getTimeBucket());
      if (!cached) {
        translationCache.set(sentenceKey, {
          translatedText: breakdownData.translation,
          breakdownData,
          timestamp: Date.now(),
          speaker: state.speakerName,
          originalText: sentence.text,
        });
        cacheBreakdown(sentence.text, breakdownData);
      }

      if (breakdownData.words) {
        recordWordFrequencies(breakdownData.words, sentenceKey);
        cacheWords(breakdownData.words);
      }

      repaintIncremental(container);
    } catch (error) {
      debugLog('MM-INC-ERROR', `Error: ${error.message}`);
      // Retry transient failures (offscreen doc reaped, fetch timeout) a bounded
      // number of times so the sentence isn't permanently skipped (left gray).
      const attempts = (sentence.attempts || 0) + 1;
      if (attempts < MM_MAX_SENTENCE_ATTEMPTS) {
        ms.processingQueue.push({ ...sentence, attempts });
        debugLog('MM-INC-RETRY', `Re-queued (attempt ${attempts}): "${sentence.text.slice(0, 40)}"`);
      } else {
        debugLog('MM-INC-GIVEUP', `Giving up after ${attempts} attempts: "${sentence.text.slice(0, 40)}"`);
      }
    }
  }

  ms.isProcessing = false;
}

/**
 * Rebuild the message element's DOM: colored spans for processed words, plain
 * escaped text for the pending tail. Exported so dom-fighter's repaint branch
 * can call it directly when Meet strips our spans.
 */
export function repaintIncremental(container) {
  const state = translationState.get(container);
  const ms = state?.minimalisticIncrementalState;
  if (!ms || !state.shadowOriginalEl) return;

  // Only the processed prefix (sourced from the API) is colored. The tail past
  // `lastProcessedIndex` stays plain text — coloring it from the word cache on
  // every live update caused visible flashes, because Meet's engine keeps
  // rewriting the tail and our spans get stripped+repainted on each keystroke.
  debugLog('MM-INC-PAINT', `len=${ms.fullText.length}, words=${ms.aggregateWords.length}`);
  paintWordColoring(state.shadowOriginalEl, ms.fullText, ms.aggregateWords, ms.processedSentences);
  attachHoverListeners(container, { words: ms.aggregateWords });
}

/**
 * Speaker change flushed the live container: process any un-terminated tail
 * as a final sentence so the caption ends fully colored.
 */
export async function finalizeMinimalisticIncremental(container) {
  const state = translationState.get(container);
  const ms = state?.minimalisticIncrementalState;
  if (!ms) return;

  debugLog('MM-INC-FINALIZE', `up to idx=${ms.lastProcessedIndex}, total=${ms.fullText.length}`);

  if (ms.debounceTimer) {
    clearTimeout(ms.debounceTimer);
    ms.debounceTimer = null;
  }
  if (ms.settleTimer) {
    clearTimeout(ms.settleTimer);
    ms.settleTimer = null;
  }

  const finalText = state.shadowOriginalEl?.textContent?.trim() || ms.fullText;
  ms.fullText = finalText;
  state.originalText = finalText;

  const remainingText = finalText.slice(ms.lastProcessedIndex).trim();
  if (remainingText.length > 0) {
    ms.processingQueue.push({
      text: remainingText,
      startIndex: ms.lastProcessedIndex,
      endIndex: finalText.length,
    });
    ms.lastProcessedIndex = finalText.length;
    await processIncrementalQueue(container);
  }
}
