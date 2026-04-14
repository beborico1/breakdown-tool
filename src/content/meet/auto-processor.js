import { debugLog } from '../core/debug.js';
import {
  minimalisticModeEnabled,
  translationState,
  translationCache,
  activeContentKeys
} from '../core/state.js';
import { findCachedTranslation, generateContentKey, getTimeBucket, cacheBreakdown } from '../core/cache.js';
import { analyzeJapaneseWithGemini } from '../core/api.js';
import { recordWordFrequencies } from '../services/frequency-tracker.js';
import { hideOriginalElement } from '../utils/dom.js';
import { renderBreakdownPanel } from './panel-mode.js';
import { initializeMinimalisticContainer } from './minimalistic-mode.js';
import { removeOverlay } from './caption-handler.js';
import { finalizeSentenceProcessing } from './sentence-processor.js';

/**
 * Auto-process the second-to-last caption card when a new card appears
 * The last card is skipped because it's still being updated as the speaker talks
 */
export async function autoProcessPreviousCard() {
  // Get all caption containers in DOM order
  const allContainers = document.querySelectorAll('.nMcdL');

  // Need at least 2 containers to process the previous one
  if (allContainers.length < 2) {
    return;
  }

  // Get the second-to-last container (index -2)
  const previousContainer = allContainers[allContainers.length - 2];

  // If previous container was sentence-processed, finalize it
  if (translationState.has(previousContainer)) {
    const state = translationState.get(previousContainer);
    if (state.sentenceState) {
      debugLog('AUTO-PROCESS', 'Finalizing sentence-processed previous card');
      finalizeSentenceProcessing(previousContainer);
      return;
    }
    // Skip if already processed (has breakdownData or minimalisticState)
    if (state.breakdownData || state.minimalisticState) {
      debugLog('AUTO-PROCESS', 'Previous card already processed, skipping');
      return;
    }
  }

  // Find the message element
  const messageEl = previousContainer.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original]):not([data-mm-display])');
  if (!messageEl) {
    debugLog('AUTO-PROCESS', 'No message element found in previous card');
    return;
  }

  const originalText = messageEl.textContent?.trim();
  if (!originalText) {
    debugLog('AUTO-PROCESS', 'No text in previous card');
    return;
  }

  // Get speaker name
  const nameEl = previousContainer.querySelector('.NWpY1d');
  const speaker = nameEl?.textContent?.trim() || '(unknown)';

  debugLog('AUTO-PROCESS', `Processing previous card: speaker="${speaker}", text="${originalText.slice(0, 40)}..."`);

  // Branch based on minimalistic mode
  if (minimalisticModeEnabled) {
    debugLog('AUTO-PROCESS', 'Using minimalistic mode');
    initializeMinimalisticContainer(previousContainer, messageEl, originalText, speaker);
    return;
  }

  // Check cache first
  const cached = findCachedTranslation(speaker, originalText);

  // Create placeholder element (kept for error states, but hidden during normal processing)
  const translatedEl = document.createElement('div');
  translatedEl.className = messageEl.className;
  translatedEl.setAttribute('data-translated', 'true');
  translatedEl.style.display = 'none'; // Always hidden initially

  if (cached?.breakdownData) {
    debugLog('AUTO-PROCESS', 'Using cached breakdown');
    // Shadow element strategy: hide original only for cached results
    hideOriginalElement(messageEl);
  } else {
    // Show processing indicator on original text (gray color)
    messageEl.setAttribute('data-processing', 'true');
  }
  messageEl.insertAdjacentElement('afterend', translatedEl);

  // Clone original for fallback
  const originalEl = messageEl.cloneNode(true);
  originalEl.style.cssText = '';
  originalEl.removeAttribute('data-shadow-original');

  // Generate content key
  const contentKey = cached?.contentKey || generateContentKey(speaker, originalText, getTimeBucket());

  // Store state
  translationState.set(previousContainer, {
    originalText,
    originalEl,
    translatedText: cached?.translatedText || null,
    translatedEl,
    contentKey,
    lastTranslatedLength: originalText.length,
    shadowOriginalEl: messageEl,
    speakerName: speaker,
    isIncremental: false,
    breakdownData: cached?.breakdownData || null,
    isExpanded: true
  });

  // Mark as active
  activeContentKeys.add(contentKey);

  // If cached, render and return
  if (cached?.breakdownData) {
    renderBreakdownPanel(previousContainer, cached.breakdownData, speaker);
    debugLog('AUTO-PROCESS', 'Applied cached breakdown');
    return;
  }

  // Analyze with Gemini
  try {
    const breakdownData = await analyzeJapaneseWithGemini(originalText);

    // Check if state still exists
    if (!translationState.has(previousContainer)) {
      debugLog('AUTO-PROCESS', 'State removed during analysis, discarding');
      return;
    }

    // Remove processing indicator from original and hide it
    messageEl.removeAttribute('data-processing');
    hideOriginalElement(messageEl);

    // Update state
    const state = translationState.get(previousContainer);
    state.breakdownData = breakdownData;
    state.translatedText = breakdownData.translation;

    // Render breakdown panel
    renderBreakdownPanel(previousContainer, breakdownData, speaker);

    // Remove translatedEl — translation is in the breakdown panel
    if (state.translatedEl?.parentNode) {
      state.translatedEl.remove();
    }

    // Record word frequencies
    recordWordFrequencies(breakdownData.words, contentKey);

    // Cache the result
    translationCache.set(contentKey, {
      translatedText: breakdownData.translation,
      breakdownData: breakdownData,
      timestamp: Date.now(),
      speaker,
      originalText
    });
    cacheBreakdown(originalText, breakdownData);
    debugLog('AUTO-PROCESS', 'Breakdown complete and cached');

  } catch (error) {
    console.error('Auto-process error:', error);
    debugLog('AUTO-PROCESS', 'Error:', error.message);

    if (!translationState.has(previousContainer)) return;

    // Remove processing indicator on error
    messageEl.removeAttribute('data-processing');
    hideOriginalElement(messageEl);

    translatedEl.textContent = `[Error: ${error.message}]`;
    translatedEl.style.display = '';
    translatedEl.setAttribute('data-error', 'true');

    // Clean up after 3 seconds
    setTimeout(() => {
      if (translationState.has(previousContainer)) {
        removeOverlay(previousContainer);
      }
    }, 3000);
  }
}
