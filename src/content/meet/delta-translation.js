import { debugLog } from '../core/debug.js';
import { translationState, pendingDeltas, translationCache, DELTA_DEBOUNCE_MS } from '../core/state.js';
import { translateToEnglish } from '../core/api.js';

/**
 * Classify text change to determine translation strategy
 * @param {string} oldText - Previously translated text
 * @param {string} newText - New text from shadow element
 * @returns {{type: 'append'|'correction'|'full'|'none', delta?: string, newText?: string, commonPrefixLength?: number}}
 */
export function classifyTextChange(oldText, newText) {
  // Check for simple append (most common case for live captions)
  if (newText.startsWith(oldText)) {
    const delta = newText.slice(oldText.length);
    if (delta.length > 0) {
      return { type: 'append', delta };
    }
    return { type: 'none' };
  }

  // Find common prefix length for corrections
  let i = 0;
  while (i < oldText.length && i < newText.length && oldText[i] === newText[i]) {
    i++;
  }

  // If more than 80% of old text is preserved, treat as correction
  if (oldText.length > 0 && i / oldText.length > 0.8) {
    return { type: 'correction', newText, commonPrefixLength: i };
  }

  // Full re-translation needed
  return { type: 'full', newText };
}

/**
 * Queue a delta translation with debouncing
 * @param {HTMLElement} container
 * @param {string} delta - New text to translate
 * @param {string} fullNewText - Complete new text
 */
export function queueDeltaTranslation(container, delta, fullNewText) {
  // Clear any pending delta for this container
  const existingTimeout = pendingDeltas.get(container);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // Mark as updating
  const state = translationState.get(container);
  if (state?.translatedEl) {
    state.translatedEl.setAttribute('data-updating', 'true');
  }

  const timeoutId = setTimeout(async () => {
    pendingDeltas.delete(container);
    await executeDeltaTranslation(container, delta, fullNewText);
  }, DELTA_DEBOUNCE_MS);

  pendingDeltas.set(container, timeoutId);
  debugLog('DELTA-QUEUE', `Queued delta translation: "${delta.slice(0, 30)}..."`);
}

/**
 * Execute a delta translation
 * @param {HTMLElement} container
 * @param {string} delta - Text to translate
 * @param {string} fullNewText - Complete original text
 */
async function executeDeltaTranslation(container, delta, fullNewText) {
  const state = translationState.get(container);
  if (!state) {
    debugLog('DELTA-EXEC', 'State no longer exists, skipping');
    return;
  }

  debugLog('DELTA-EXEC', `Translating delta: "${delta.slice(0, 40)}..."`);

  try {
    // The on-device translator has no conversation context, so the delta is
    // translated on its own; the previous translation is only used to append to.
    const translatedDelta = await translateToEnglish(delta);

    // Check if state still exists (user may have toggled off)
    if (!translationState.has(container)) {
      debugLog('DELTA-EXEC', 'Container toggled off during translation');
      return;
    }

    // Append translated delta to existing translation
    const newTranslatedText = state.translatedText + ' ' + translatedDelta;
    state.translatedText = newTranslatedText;
    state.translatedEl.textContent = newTranslatedText;
    state.translatedEl.removeAttribute('data-updating');
    state.translatedEl.removeAttribute('data-has-delta');

    // Update tracking
    state.originalText = fullNewText;
    state.lastTranslatedLength = fullNewText.length;

    // Update cache
    if (state.contentKey) {
      const cacheEntry = translationCache.get(state.contentKey);
      if (cacheEntry) {
        cacheEntry.translatedText = newTranslatedText;
        cacheEntry.originalText = fullNewText;
        cacheEntry.timestamp = Date.now();
      }
    }

    debugLog('DELTA-EXEC', `Updated translation: "${newTranslatedText.slice(-60)}..."`);
  } catch (error) {
    debugLog('DELTA-EXEC', 'Delta translation failed:', error.message);
    state.translatedEl?.removeAttribute('data-updating');
  }
}

/**
 * Execute a full re-translation (for major text changes)
 * @param {HTMLElement} container
 * @param {string} text
 */
export async function executeFullRetranslation(container, text) {
  const state = translationState.get(container);
  if (!state) return;

  state.translatedEl?.setAttribute('data-updating', 'true');

  try {
    const translated = await translateToEnglish(text);

    if (!translationState.has(container)) return;

    state.translatedText = translated;
    state.translatedEl.textContent = translated;
    state.translatedEl.removeAttribute('data-updating');
    state.originalText = text;
    state.lastTranslatedLength = text.length;

    // Update cache
    if (state.contentKey) {
      const cacheEntry = translationCache.get(state.contentKey);
      if (cacheEntry) {
        cacheEntry.translatedText = translated;
        cacheEntry.originalText = text;
        cacheEntry.timestamp = Date.now();
      }
    }

    debugLog('FULL-RETRANS', 'Completed full re-translation');
  } catch (error) {
    debugLog('FULL-RETRANS', 'Failed:', error.message);
    state.translatedEl?.removeAttribute('data-updating');
  }
}

/**
 * Handle text updates from shadow original elements
 * @param {HTMLElement} container
 * @param {string} newText
 */
export function handleTextUpdate(container, newText) {
  const state = translationState.get(container);
  if (!state || !state.isIncremental) return;

  const oldText = state.originalText;
  if (newText === oldText) return; // No change

  debugLog('TEXT-UPDATE', `Old: "${oldText.slice(-30)}" -> New: "${newText.slice(-30)}"`);

  const change = classifyTextChange(oldText, newText);
  debugLog('TEXT-UPDATE', `Change type: ${change.type}`);

  switch (change.type) {
    case 'none':
      // No meaningful change
      break;

    case 'append':
      // Queue delta translation
      queueDeltaTranslation(container, change.delta, newText);
      break;

    case 'correction':
      // For corrections, we could be smarter but for now re-translate from correction point
      // This is a simplification - a more sophisticated approach would re-translate only the changed part
      debugLog('TEXT-UPDATE', 'Correction detected, re-translating changed portion');
      queueDeltaTranslation(container, newText.slice(change.commonPrefixLength), newText);
      break;

    case 'full':
      // Full re-translation needed (rare case)
      debugLog('TEXT-UPDATE', 'Full re-translation needed');
      // Cancel any pending delta
      const pendingTimeout = pendingDeltas.get(container);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDeltas.delete(container);
      }
      // Trigger full re-translation by updating state and calling translate
      state.originalText = newText;
      state.lastTranslatedLength = 0;
      executeFullRetranslation(container, newText);
      break;
  }
}

/**
 * Update visual display with untranslated delta text (no API call)
 * Shows: [already translated text] [new untranslated original text]
 * @param {HTMLElement} container
 */
export function updateVisualDelta(container) {
  const state = translationState.get(container);
  if (!state?.shadowOriginalEl || !state.isIncremental) return;

  const currentText = state.shadowOriginalEl.textContent?.trim() || '';
  const translatedPortion = state.originalText; // What we've already translated

  // Only show delta if new text is appended to what we've translated
  if (currentText.length > translatedPortion.length && currentText.startsWith(translatedPortion)) {
    const untranslatedDelta = currentText.slice(translatedPortion.length);
    // Show: translated + untranslated original (mixed display)
    state.translatedEl.textContent = state.translatedText + ' ' + untranslatedDelta;
    state.translatedEl.setAttribute('data-has-delta', 'true');
    debugLog('VISUAL-DELTA', `Showing untranslated delta: "${untranslatedDelta.slice(0, 40)}..."`);
  }
}
