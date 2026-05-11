import { debugLog } from '../core/debug.js';
import {
  minimalisticModeEnabled,
  translationState,
  translationCache,
  activeContentKeys,
  pendingDeltas
} from '../core/state.js';
import { findCachedTranslation, generateContentKey, getTimeBucket, cacheBreakdown } from '../core/cache.js';
import { analyzeJapaneseWithGemini } from '../core/api.js';
import { recordWordFrequencies } from '../services/frequency-tracker.js';
import { hideOriginalElement } from '../utils/dom.js';
import { renderBreakdownPanel, reprocessBreakdown } from './panel-mode.js';
import { queueDeltaTranslation } from './delta-translation.js';

/**
 * Remove overlay and clean up translation state for a container
 * @param {HTMLElement} container
 */
export function removeOverlay(container) {
  const state = translationState.get(container);

  // Cancel any pending delta translation
  const pendingTimeout = pendingDeltas.get(container);
  if (pendingTimeout) {
    clearTimeout(pendingTimeout);
    pendingDeltas.delete(container);
  }

  // Remove breakdown panel if present
  const breakdownPanel = container.querySelector('.breakdown-wrapper:not([data-sentence-mode])');
  if (breakdownPanel) {
    breakdownPanel.remove();
  }

  // Remove sentence-mode wrapper if present
  const sentenceWrapper = container.querySelector('.breakdown-wrapper[data-sentence-mode]');
  if (sentenceWrapper) {
    sentenceWrapper.remove();
  }

  // Clear sentence debounce timer
  if (state?.sentenceState?.debounceTimer) {
    clearTimeout(state.sentenceState.debounceTimer);
  }

  if (state?.translatedEl && state.translatedEl.parentNode) {
    // Handle shadow original element (incremental mode)
    if (state.shadowOriginalEl && state.shadowOriginalEl.parentNode) {
      // Restore shadow original to visible state
      state.shadowOriginalEl.style.cssText = '';
      state.shadowOriginalEl.removeAttribute('data-shadow-original');
      // Remove translated element
      state.translatedEl.remove();
      debugLog('TOGGLE-OFF', 'Restored shadow original element');
    } else if (state.originalEl) {
      // Legacy mode: replace translated with clone
      state.translatedEl.replaceWith(state.originalEl);
      debugLog('TOGGLE-OFF', 'Restored original element');
    } else {
      state.translatedEl.remove();
    }
  }
  // Clear from active keys so it won't auto-reapply
  if (state?.contentKey) {
    activeContentKeys.delete(state.contentKey);
    debugLog('TOGGLE-OFF', `Removed from active keys: ${state.contentKey.slice(0, 50)}`);
  }
  translationState.delete(container);
}

/**
 * Handle click on a caption to translate it
 * @param {Event} event
 */
export async function handleCaptionClick(event) {
  const container = event.currentTarget;

  // Check if click was on a breakdown panel button (let it handle itself)
  if (event.target.closest('.breakdown-actions')) {
    return;
  }

  // In minimalistic mode, clicking a transcription copies it to clipboard — nothing else.
  if (minimalisticModeEnabled) {
    event.stopPropagation();
    const text = (container.textContent || '').trim();
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        debugLog('MM-COPY', 'Copied transcription:', text.slice(0, 80));
      }).catch(err => {
        debugLog('MM-COPY', 'Failed:', err.message);
      });
    }
    return;
  }

  // If already has state, handle accordingly
  if (translationState.has(container)) {
    const state = translationState.get(container);

    // Handle sentence-processed containers: toggle expand/collapse
    if (state.sentenceState) {
      const wrapper = container.querySelector('.breakdown-wrapper[data-sentence-mode]');
      if (wrapper) {
        const isExpanded = wrapper.getAttribute('data-expanded') === 'true';
        wrapper.setAttribute('data-expanded', !isExpanded ? 'true' : 'false');
        state.isExpanded = !isExpanded;
        debugLog('SENTENCE-CLICK', `Sentence wrapper ${!isExpanded ? 'expanded' : 'collapsed'}`);
      }
      return;
    }

    // If breakdown panel exists, check for new text or toggle
    if (state.breakdownData) {
      const currentText = state.shadowOriginalEl?.textContent?.trim() || '';

      // If there's new text, reprocess the entire message
      if (currentText.length > state.originalText.length && currentText.startsWith(state.originalText)) {
        debugLog('REPROCESS', `New text detected, reprocessing full message`);
        // Update state and trigger reanalysis
        state.originalText = currentText;
        state.breakdownData = null; // Clear old breakdown
        // Remove old panel and show loading
        const panel = container.querySelector('.breakdown-wrapper:not([data-sentence-mode])');
        if (panel) panel.remove();
        // Show loading indicator
        state.translatedEl.style.display = '';
        state.translatedEl.setAttribute('data-loading', 'true');
        state.translatedEl.textContent = 'Reanalyzing...';
        // Trigger new analysis
        reprocessBreakdown(container, currentText, state.speakerName);
        return;
      }

      // No new text - toggle off (remove overlay)
      removeOverlay(container);
      return;
    }

    // Check if shadow element has new text (delta available) - for legacy mode
    if (state.shadowOriginalEl && state.isIncremental && !state.breakdownData) {
      const currentText = state.shadowOriginalEl.textContent?.trim() || '';
      if (currentText.length > state.originalText.length && currentText.startsWith(state.originalText)) {
        // New text appended - translate delta instead of toggling off
        const delta = currentText.slice(state.originalText.length);
        debugLog('CLICK-DELTA', `Found new text, translating delta: "${delta.slice(0, 40)}..."`);
        queueDeltaTranslation(container, delta, currentText);
        return;
      }
    }

    // No new text - toggle off (remove overlay)
    debugLog('TOGGLE-OFF', 'Removing translation overlay');
    removeOverlay(container);
    return;
  }

  // Find the original (non-translated, non-shadow) caption element
  const messageEl = container.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original])');
  if (!messageEl) return;

  debugLog('CLICK', 'Container clicked, text:', messageEl.textContent?.trim().slice(0, 60));

  const originalText = messageEl.textContent?.trim();
  if (!originalText) return;

  // Get speaker name for content key
  const nameEl = container.querySelector('.NWpY1d');
  const speaker = nameEl?.textContent?.trim() || '(unknown)';

  // Check cache first (now caches breakdown data)
  const cached = findCachedTranslation(speaker, originalText);

  // Create a placeholder element (kept for error states, but hidden during normal processing)
  const translatedEl = document.createElement('div');
  translatedEl.className = messageEl.className;
  translatedEl.setAttribute('data-translated', 'true');
  translatedEl.style.display = 'none'; // Always hidden initially

  // If cached with breakdown data, render immediately
  if (cached?.breakdownData) {
    debugLog('CACHE-HIT', `Using cached breakdown for: ${originalText.slice(0, 40)}`);
  } else {
    // Show processing indicator on original text (gray color)
    messageEl.setAttribute('data-processing', 'true');
  }

  // Shadow element strategy: hide original only for cached results
  if (cached?.breakdownData) {
    hideOriginalElement(messageEl);
  }

  // Insert translated element after the hidden original
  messageEl.insertAdjacentElement('afterend', translatedEl);

  // Clone original for fallback restoration
  const originalEl = messageEl.cloneNode(true);
  originalEl.style.cssText = '';
  originalEl.removeAttribute('data-shadow-original');

  // Generate content key for new translations
  const contentKey = cached?.contentKey || generateContentKey(speaker, originalText, getTimeBucket());

  // Store state
  translationState.set(container, {
    originalText,
    originalEl,
    translatedText: cached?.translatedText || null,
    translatedEl,
    contentKey,
    lastTranslatedLength: originalText.length,
    shadowOriginalEl: messageEl,
    speakerName: speaker,
    isIncremental: false, // Breakdown mode doesn't support incremental updates
    breakdownData: cached?.breakdownData || null,
    isExpanded: true
  });

  // Mark as active
  activeContentKeys.add(contentKey);

  // If cached with breakdown, render panel and we're done
  if (cached?.breakdownData) {
    renderBreakdownPanel(container, cached.breakdownData, speaker);
    debugLog('TRANSLATE', 'Applied cached breakdown');
    return;
  }

  debugLog('TRANSLATE', 'Starting Japanese analysis');

  try {
    const breakdownData = await analyzeJapaneseWithGemini(originalText);

    // Check if user toggled off while analysis was in flight
    if (!translationState.has(container)) {
      debugLog('TRANSLATE', 'User toggled off during analysis, discarding result');
      return;
    }

    // Remove processing indicator from original and hide it
    messageEl.removeAttribute('data-processing');
    hideOriginalElement(messageEl);

    // Update state with breakdown data
    const state = translationState.get(container);
    state.breakdownData = breakdownData;
    state.translatedText = breakdownData.translation;

    // Render the breakdown panel
    renderBreakdownPanel(container, breakdownData, speaker);

    // Remove translatedEl — translation is in the breakdown panel
    if (state.translatedEl?.parentNode) {
      state.translatedEl.remove();
    }

    // Record word frequencies
    recordWordFrequencies(breakdownData.words, contentKey);

    // Store in cache for persistence
    translationCache.set(contentKey, {
      translatedText: breakdownData.translation,
      breakdownData: breakdownData,
      timestamp: Date.now(),
      speaker,
      originalText
    });
    cacheBreakdown(originalText, breakdownData);
    debugLog('CACHE-SET', `Cached breakdown: ${contentKey.slice(0, 50)}`);

    debugLog('TRANSLATE', 'Breakdown panel rendered');
  } catch (error) {
    console.error('Analysis error:', error);
    debugLog('TRANSLATE', 'Error:', error.message);

    // Check if user toggled off
    if (!translationState.has(container)) return;

    // Remove processing indicator on error
    messageEl.removeAttribute('data-processing');
    hideOriginalElement(messageEl);

    translatedEl.textContent = `[Error: ${error.message}]`;
    translatedEl.style.display = '';
    translatedEl.setAttribute('data-error', 'true');

    // Clean up after 3 seconds to allow retry
    setTimeout(() => {
      if (translationState.has(container)) {
        removeOverlay(container);
      }
    }, 3000);
  }
}
