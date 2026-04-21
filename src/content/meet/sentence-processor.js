import { debugLog } from '../core/debug.js';
import {
  translationState,
  translationCache,
  activeContentKeys,
  SENTENCE_DEBOUNCE_MS,
  wordBlockFontSize,
  sentenceChunkSize
} from '../core/state.js';
import { findCachedTranslation, generateContentKey, getTimeBucket, cacheBreakdown } from '../core/cache.js';
import { analyzeJapaneseWithGemini } from '../core/api.js';
import { recordWordFrequencies } from '../services/frequency-tracker.js';
import { hideOriginalElement } from '../utils/dom.js';
import { getWordTypeClass } from '../utils/text.js';
import { applyFontSizeToWrapper } from './panel-mode.js';

// Sentence-ending characters
const SENTENCE_ENDERS = /[。！？]/;

/**
 * Initialize sentence-level processing on the current (last) caption container.
 * Called when a new container appears and is the active speaker's card.
 * @param {HTMLElement} container
 */
export function initializeSentenceProcessing(container) {
  const messageEl = container.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original]):not([data-mm-colored])');
  if (!messageEl) return;

  const nameEl = container.querySelector('.NWpY1d');
  const speaker = nameEl?.textContent?.trim() || '(unknown)';
  const initialText = messageEl.textContent?.trim() || '';

  debugLog('SENTENCE-INIT', `Initializing for speaker="${speaker}", text="${initialText.slice(0, 40)}..."`);

  // Hide the original message element (shadow strategy)
  hideOriginalElement(messageEl);

  // Create a hidden placeholder translated element (for state compatibility)
  const translatedEl = document.createElement('div');
  translatedEl.className = messageEl.className;
  translatedEl.setAttribute('data-translated', 'true');
  translatedEl.style.display = 'none';
  messageEl.insertAdjacentElement('afterend', translatedEl);

  // Clone original for fallback restoration
  const originalEl = messageEl.cloneNode(true);
  originalEl.style.cssText = '';
  originalEl.removeAttribute('data-shadow-original');

  // Generate content key
  const contentKey = generateContentKey(speaker, initialText || 'sentence-init', getTimeBucket());

  // Create the breakdown wrapper with sentence mode
  const wrapper = document.createElement('div');
  wrapper.className = 'breakdown-wrapper';
  wrapper.setAttribute('data-sentence-mode', 'true');
  wrapper.setAttribute('data-expanded', 'true');

  // Live text element at the bottom (shows unprocessed incoming text in white)
  const liveTextDiv = document.createElement('div');
  liveTextDiv.className = 'sentence-live-text';
  liveTextDiv.textContent = initialText;
  wrapper.appendChild(liveTextDiv);

  applyFontSizeToWrapper(wrapper, wordBlockFontSize);
  container.appendChild(wrapper);

  // Build sentence state
  const sentenceState = {
    processedSentences: [],
    processingQueue: [],
    isProcessing: false,
    lastProcessedIndex: 0,
    debounceTimer: null,
    fullText: initialText
  };

  // Store state on the container
  translationState.set(container, {
    originalText: initialText,
    originalEl,
    translatedText: null,
    translatedEl,
    contentKey,
    lastTranslatedLength: 0,
    shadowOriginalEl: messageEl,
    speakerName: speaker,
    isIncremental: false,
    breakdownData: null,
    isExpanded: true,
    sentenceState
  });

  activeContentKeys.add(contentKey);

  // Check if initial text already contains sentence enders
  scanForSentenceEnders(container);
}

/**
 * Handle text updates for a container in sentence-processing mode.
 * Called from dom-fighter.js on characterData mutations.
 * @param {HTMLElement} container
 */
export function handleSentenceTextUpdate(container) {
  const state = translationState.get(container);
  if (!state?.sentenceState) return;

  const ss = state.sentenceState;
  const newText = state.shadowOriginalEl?.textContent?.trim() || '';

  if (newText === ss.fullText) return; // No change

  debugLog('SENTENCE-UPDATE', `Text changed: "${newText.slice(0, 60)}..." (len=${newText.length})`);
  ss.fullText = newText;
  state.originalText = newText;

  // Update the live text display with unprocessed portion
  updateLiveText(container);

  // Scan for sentence enders in the new text
  scanForSentenceEnders(container);
}

/**
 * Scan text for sentence enders beyond lastProcessedIndex, debounce, and queue.
 * @param {HTMLElement} container
 */
function scanForSentenceEnders(container) {
  const state = translationState.get(container);
  if (!state?.sentenceState) return;

  const ss = state.sentenceState;
  const text = ss.fullText;

  // Look for sentence enders beyond what we've already processed
  let searchFrom = ss.lastProcessedIndex;
  const enders = [];

  for (let i = searchFrom; i < text.length; i++) {
    if (SENTENCE_ENDERS.test(text[i])) {
      enders.push(i);
    }
  }

  if (enders.length === 0) return;

  // Clear existing debounce timer
  if (ss.debounceTimer) {
    clearTimeout(ss.debounceTimer);
    ss.debounceTimer = null;
  }

  // Debounce: wait for speech recognition to settle
  ss.debounceTimer = setTimeout(() => {
    ss.debounceTimer = null;

    // Re-read the text after debounce (speech recognition may have corrected)
    const currentText = state.shadowOriginalEl?.textContent?.trim() || '';
    ss.fullText = currentText;
    state.originalText = currentText;

    // Re-scan for enders after debounce
    const confirmedEnders = [];
    for (let i = ss.lastProcessedIndex; i < currentText.length; i++) {
      if (SENTENCE_ENDERS.test(currentText[i])) {
        confirmedEnders.push(i);
      }
    }

    if (confirmedEnders.length === 0) {
      updateLiveText(container);
      return;
    }

    // confirmedEnders is a full rescan of the unprocessed buffer from
    // lastProcessedIndex, so its length IS the number of sentence-ending
    // marks currently pending. Compare directly against the threshold —
    // do not accumulate across debounce fires, which would re-count the
    // same 。 every time Meet restreams mid-sentence text.
    if (confirmedEnders.length < sentenceChunkSize) {
      debugLog('SENTENCE-CHUNK', `${confirmedEnders.length}/${sentenceChunkSize} enders in unprocessed buffer, waiting for more`);
      updateLiveText(container);
      return;
    }

    // Threshold reached — queue all text from lastProcessedIndex to last ender as one chunk
    const lastEnderIdx = confirmedEnders[confirmedEnders.length - 1];
    const chunkText = currentText.slice(ss.lastProcessedIndex, lastEnderIdx + 1).trim();
    if (chunkText.length > 0) {
      ss.processingQueue.push({
        text: chunkText,
        startIndex: ss.lastProcessedIndex,
        endIndex: lastEnderIdx + 1
      });
      debugLog('SENTENCE-QUEUE', `Queued chunk (${confirmedEnders.length} enders): "${chunkText.slice(0, 60)}"`);
    }

    ss.lastProcessedIndex = lastEnderIdx + 1;

    updateLiveText(container);
    processSentenceQueue(container);
  }, SENTENCE_DEBOUNCE_MS);
}

/**
 * Update the live text display with the unprocessed portion of text.
 * @param {HTMLElement} container
 */
function updateLiveText(container) {
  const state = translationState.get(container);
  if (!state?.sentenceState) return;

  const ss = state.sentenceState;
  const wrapper = container.querySelector('.breakdown-wrapper[data-sentence-mode]');
  if (!wrapper) return;

  const liveTextDiv = wrapper.querySelector('.sentence-live-text');
  if (!liveTextDiv) return;

  const pendingText = ss.fullText.slice(ss.lastProcessedIndex).trim();
  liveTextDiv.textContent = pendingText;
  liveTextDiv.style.display = pendingText ? '' : 'none';
}

/**
 * Process queued sentences one at a time (serialized).
 * @param {HTMLElement} container
 */
async function processSentenceQueue(container) {
  const state = translationState.get(container);
  if (!state?.sentenceState) return;

  const ss = state.sentenceState;

  if (ss.isProcessing) return; // Already processing
  if (ss.processingQueue.length === 0) return;

  ss.isProcessing = true;

  while (ss.processingQueue.length > 0) {
    // Check state still exists
    if (!translationState.has(container)) {
      ss.isProcessing = false;
      return;
    }

    const sentence = ss.processingQueue.shift();
    const wrapper = container.querySelector('.breakdown-wrapper[data-sentence-mode]');
    if (!wrapper) break;

    // Show processing indicator for this sentence
    const processingDiv = document.createElement('div');
    processingDiv.className = 'sentence-processing-text';
    processingDiv.textContent = sentence.text;
    const liveTextDiv = wrapper.querySelector('.sentence-live-text');
    wrapper.insertBefore(processingDiv, liveTextDiv);

    debugLog('SENTENCE-PROCESS', `Processing: "${sentence.text.slice(0, 40)}"`);

    try {
      // Check cache first
      const cached = findCachedTranslation(state.speakerName, sentence.text);
      let breakdownData;

      if (cached?.breakdownData) {
        debugLog('SENTENCE-CACHE', `Cache hit for: "${sentence.text.slice(0, 30)}"`);
        breakdownData = cached.breakdownData;
      } else {
        breakdownData = await analyzeJapaneseWithGemini(sentence.text);
      }

      // Verify state still exists after async call
      if (!translationState.has(container)) {
        ss.isProcessing = false;
        return;
      }

      // Remove processing indicator
      processingDiv.remove();

      // Append sentence breakdown
      appendSentenceBreakdown(wrapper, breakdownData, state.speakerName);

      // Record in state
      ss.processedSentences.push({
        text: sentence.text,
        breakdownData,
        startIndex: sentence.startIndex,
        endIndex: sentence.endIndex
      });

      // Record word frequencies
      const sentenceKey = generateContentKey(state.speakerName, sentence.text, getTimeBucket());
      recordWordFrequencies(breakdownData.words, sentenceKey);

      // Cache the result
      if (!cached) {
        translationCache.set(sentenceKey, {
          translatedText: breakdownData.translation,
          breakdownData,
          timestamp: Date.now(),
          speaker: state.speakerName,
          originalText: sentence.text
        });
        cacheBreakdown(sentence.text, breakdownData);
      }

      debugLog('SENTENCE-DONE', `Processed: "${sentence.text.slice(0, 30)}" → "${breakdownData.translation?.slice(0, 40)}"`);

    } catch (error) {
      console.error('Sentence processing error:', error);
      debugLog('SENTENCE-ERROR', `Error processing: ${error.message}`);

      // Remove processing indicator and show error briefly
      processingDiv.classList.remove('sentence-processing-text');
      processingDiv.style.color = '#EA4335';
      processingDiv.textContent = `[Error: ${error.message}]`;

      // Clean up error after 3 seconds
      setTimeout(() => {
        if (processingDiv.parentNode) {
          processingDiv.remove();
        }
      }, 3000);
    }
  }

  ss.isProcessing = false;
}

/**
 * Append a processed sentence's breakdown (word blocks + translation) to the wrapper.
 * Inserted before the .sentence-live-text div so live text stays at the bottom.
 * @param {HTMLElement} wrapper
 * @param {Object} breakdownData
 * @param {string} speakerName
 */
function appendSentenceBreakdown(wrapper, breakdownData, speakerName) {
  const group = document.createElement('div');
  group.className = 'sentence-group';

  // Word blocks
  breakdownData.words.forEach(word => {
    const block = document.createElement('div');
    block.className = 'word-block';
    const typeClass = getWordTypeClass(word.type);
    const typeLabel = typeClass.charAt(0).toUpperCase() + typeClass.slice(1);
    block.innerHTML = `
      <span class="word-japanese type-${typeClass}" data-type="${typeLabel}">${word.japanese}</span>
      <span class="word-hiragana">${word.reading || word.japanese}</span>
      <span class="word-romaji">${word.romaji || '-'}</span>
      <span class="word-english">${word.english || '-'}</span>
    `;
    group.appendChild(block);
  });

  // Translation line
  const translationDiv = document.createElement('div');
  translationDiv.className = 'breakdown-translation';
  translationDiv.textContent = `"${breakdownData.translation}"`;
  group.appendChild(translationDiv);

  // Insert before live text div
  const liveTextDiv = wrapper.querySelector('.sentence-live-text');
  wrapper.insertBefore(group, liveTextDiv);
}

/**
 * Finalize sentence processing when a new speaker starts.
 * Processes any remaining pending text (even without sentence enders).
 * @param {HTMLElement} container
 */
export async function finalizeSentenceProcessing(container) {
  const state = translationState.get(container);
  if (!state?.sentenceState) return;

  const ss = state.sentenceState;

  debugLog('SENTENCE-FINALIZE', `Finalizing. Processed up to idx=${ss.lastProcessedIndex}, total len=${ss.fullText.length}`);

  // Clear any pending debounce timer
  if (ss.debounceTimer) {
    clearTimeout(ss.debounceTimer);
    ss.debounceTimer = null;
  }

  // Re-read the final text from the shadow element
  const finalText = state.shadowOriginalEl?.textContent?.trim() || ss.fullText;
  ss.fullText = finalText;
  state.originalText = finalText;

  // If there's remaining text after the last processed index, queue it
  const remainingText = finalText.slice(ss.lastProcessedIndex).trim();
  if (remainingText.length > 0) {
    ss.processingQueue.push({
      text: remainingText,
      startIndex: ss.lastProcessedIndex,
      endIndex: finalText.length
    });
    ss.lastProcessedIndex = finalText.length;

    updateLiveText(container);
    await processSentenceQueue(container);
  }
}
