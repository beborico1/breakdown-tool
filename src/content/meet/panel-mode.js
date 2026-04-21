import { debugLog } from '../core/debug.js';
import { translationState, translationCache, activeContentKeys, wordBlockFontSize } from '../core/state.js';
import { getWordTypeClass } from '../utils/text.js';
import { generateContentKey, getTimeBucket, cacheBreakdown } from '../core/cache.js';
import { analyzeJapaneseWithGemini } from '../core/api.js';
import { recordWordFrequencies } from '../services/frequency-tracker.js';

/**
 * Apply font size CSS custom properties to a single breakdown wrapper
 * @param {HTMLElement} wrapper - A .breakdown-wrapper element
 * @param {number} baseFontSize - The base (japanese) font size in px
 */
export function applyFontSizeToWrapper(wrapper, baseFontSize) {
  const scale = baseFontSize / 15;
  wrapper.style.setProperty('--wb-font-japanese', `${baseFontSize}px`);
  wrapper.style.setProperty('--wb-font-hiragana', `${Math.round(12 * scale)}px`);
  wrapper.style.setProperty('--wb-font-romaji', `${Math.round(11 * scale)}px`);
  wrapper.style.setProperty('--wb-font-english', `${Math.round(11 * scale)}px`);
  wrapper.style.setProperty('--wb-font-pending', `${Math.round(18 * scale)}px`);
  wrapper.style.setProperty('--wb-font-translation', `${Math.round(14 * scale)}px`);
  wrapper.style.setProperty('--wb-font-tooltip', `${Math.round(10 * scale)}px`);
}

/**
 * Apply font size to all existing breakdown wrappers in the DOM
 * @param {number} baseFontSize - The base (japanese) font size in px
 */
export function applyWordBlockFontSize(baseFontSize) {
  document.querySelectorAll('.breakdown-wrapper').forEach(wrapper => {
    applyFontSizeToWrapper(wrapper, baseFontSize);
  });
}

/**
 * Build a detached .breakdown-wrapper element for a breakdown.
 * Used both inline (panel mode) and as the body of the hover card.
 * @param {Object} breakdownData - Breakdown data from API
 * @param {boolean} isExpanded - Whether the wrapper should be expanded
 * @returns {HTMLElement}
 */
export function buildBreakdownPanelElement(breakdownData, isExpanded = true) {
  const panel = document.createElement('div');
  panel.className = 'breakdown-wrapper';
  panel.setAttribute('data-expanded', isExpanded ? 'true' : 'false');

  const pendingDiv = document.createElement('div');
  pendingDiv.className = 'breakdown-pending';
  pendingDiv.style.display = 'none';
  panel.appendChild(pendingDiv);

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
    panel.appendChild(block);
  });

  const translationDiv = document.createElement('div');
  translationDiv.className = 'breakdown-translation';
  translationDiv.textContent = `"${breakdownData.translation}"`;
  panel.appendChild(translationDiv);

  applyFontSizeToWrapper(panel, wordBlockFontSize);

  return panel;
}

/**
 * Render the breakdown panel inline inside a caption container.
 * @param {HTMLElement} container - Caption container element
 * @param {Object} breakdownData - Breakdown data from API
 * @param {string} speakerName - Speaker name
 * @param {boolean} isExpanded - Whether panel should be expanded (default: true)
 */
export function renderBreakdownPanel(container, breakdownData, speakerName, isExpanded = true) {
  const existingPanel = container.querySelector('.breakdown-wrapper');
  if (existingPanel) {
    existingPanel.remove();
  }

  const panel = buildBreakdownPanelElement(breakdownData, isExpanded);
  container.appendChild(panel);
}

/**
 * Reprocess breakdown panel with updated text
 * @param {HTMLElement} container - Caption container
 * @param {string} text - Full text to analyze
 * @param {string} speakerName - Speaker name
 */
export async function reprocessBreakdown(container, text, speakerName) {
  const state = translationState.get(container);
  if (!state) return;

  try {
    const breakdownData = await analyzeJapaneseWithGemini(text);

    // Check if user toggled off while analysis was in flight
    if (!translationState.has(container)) {
      debugLog('REPROCESS', 'User toggled off during reanalysis, discarding result');
      return;
    }

    // Hide the loading placeholder
    state.translatedEl.style.display = 'none';
    state.translatedEl.removeAttribute('data-loading');

    // Update state with new breakdown data
    state.breakdownData = breakdownData;
    state.translatedText = breakdownData.translation;
    state.lastTranslatedLength = text.length;

    // Render the updated breakdown panel
    renderBreakdownPanel(container, breakdownData, speakerName, state.isExpanded);

    // Remove translatedEl — translation is in the breakdown panel
    if (state.translatedEl?.parentNode) {
      state.translatedEl.remove();
    }

    // Record word frequencies (use new content key for reprocessed text)
    const reprocessKey = generateContentKey(speakerName, text, getTimeBucket());
    recordWordFrequencies(breakdownData.words, reprocessKey);

    // Update cache
    if (state.contentKey) {
      const cacheEntry = translationCache.get(state.contentKey);
      if (cacheEntry) {
        cacheEntry.translatedText = breakdownData.translation;
        cacheEntry.breakdownData = breakdownData;
        cacheEntry.originalText = text;
        cacheEntry.timestamp = Date.now();
      }
    }
    cacheBreakdown(text, breakdownData);

    debugLog('REPROCESS', 'Breakdown panel updated with new analysis');
  } catch (error) {
    console.error('Reprocess error:', error);
    debugLog('REPROCESS', 'Error:', error.message);

    // Check if user toggled off
    if (!translationState.has(container)) return;

    state.translatedEl.textContent = `[Error: ${error.message}]`;
    state.translatedEl.style.display = '';
    state.translatedEl.removeAttribute('data-loading');
    state.translatedEl.setAttribute('data-error', 'true');
  }
}

/**
 * Toggle breakdown panel expand/collapse
 * @param {HTMLElement} container - Caption container
 */
export function toggleBreakdownPanel(container) {
  const panel = container.querySelector('.breakdown-wrapper:not([data-sentence-mode])');
  if (!panel) return;

  const state = translationState.get(container);
  const isExpanded = panel.getAttribute('data-expanded') === 'true';
  const newExpandedState = !isExpanded;

  panel.setAttribute('data-expanded', newExpandedState);

  // Sync state for persistence across re-renders
  if (state) {
    state.isExpanded = newExpandedState;
  }

  const collapseBtn = panel.querySelector('[data-action="collapse"]');
  if (collapseBtn) {
    collapseBtn.textContent = newExpandedState ? '▲' : '▼';
  }

  debugLog('BREAKDOWN', `Panel ${newExpandedState ? 'expanded' : 'collapsed'}`);
}

/**
 * Handle copy action from breakdown panel
 * @param {string} action - Copy action type (japanese, romaji, translation)
 * @param {Object} breakdownData - Breakdown data
 * @param {HTMLElement} button - Button element for feedback
 */
export function handleCopyAction(action, breakdownData, button) {
  let text;
  switch (action) {
    case 'japanese':
      text = breakdownData.original;
      break;
    case 'romaji':
      text = breakdownData.words.map(w => w.romaji).join(' ');
      break;
    case 'translation':
      text = breakdownData.translation;
      break;
    default:
      return;
  }

  navigator.clipboard.writeText(text).then(() => {
    // Show brief feedback
    const originalText = button.textContent;
    button.textContent = 'Copied!';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 1500);

    debugLog('COPY', `Copied ${action}:`, text.slice(0, 50));
  }).catch(err => {
    debugLog('COPY', 'Failed:', err.message);
  });
}

/**
 * Update breakdown panel with incoming unprocessed text
 * Shows new Japanese text below the furigana line without auto-processing
 * @param {HTMLElement} container
 */
export function updateBreakdownDelta(container) {
  const state = translationState.get(container);
  if (!state?.shadowOriginalEl || !state.breakdownData) return;

  const currentText = state.shadowOriginalEl.textContent?.trim() || '';
  const processedText = state.originalText;

  if (currentText.length > processedText.length && currentText.startsWith(processedText)) {
    const newText = currentText.slice(processedText.length);
    const pendingDiv = container.querySelector('.breakdown-pending');
    if (pendingDiv) {
      pendingDiv.textContent = newText;
      pendingDiv.style.display = 'block';
      debugLog('BREAKDOWN-DELTA', `Showing pending text: "${newText.slice(0, 40)}..."`);
    }
  }
}
