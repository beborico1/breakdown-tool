import { debugLog } from '../core/debug.js';
import {
  minimalisticModeEnabled,
  setMinimalisticModeEnabled,
  translationState,
  activeContentKeys
} from '../core/state.js';
import { getWordTypeClass } from '../utils/text.js';
import { findCachedTranslation, generateContentKey, getTimeBucket, cacheBreakdown } from '../core/cache.js';
import { analyzeJapaneseWithGemini } from '../core/api.js';
import { recordWordFrequencies } from '../services/frequency-tracker.js';
import { hideOriginalElement } from '../utils/dom.js';

/**
 * Load minimalistic mode setting from storage
 */
export function loadMinimalisticMode() {
  chrome.storage.sync.get(['minimalisticModeEnabled'], (result) => {
    setMinimalisticModeEnabled(result.minimalisticModeEnabled || false);
    debugLog('MM-INIT', `Minimalistic mode: ${minimalisticModeEnabled}`);
  });
}

/**
 * Find word info for a character index
 * @param {number} charIdx - Character index in the text
 * @param {Array} wordBoundaries - Array of {startIdx, endIdx, word}
 * @returns {Object|null} - Word info or null
 */
function findWordForIndex(charIdx, wordBoundaries) {
  for (const boundary of wordBoundaries) {
    if (charIdx >= boundary.startIdx && charIdx < boundary.endIdx) {
      return boundary.word;
    }
  }
  return null;
}

/**
 * Find sentence translation for a period character
 * @param {number} charIdx - Character index of the period
 * @param {Array} sentenceRanges - Array of {startIdx, endIdx, translation}
 * @returns {string|null} - Sentence translation or null
 */
function findSentenceForIndex(charIdx, sentenceRanges) {
  for (const range of sentenceRanges) {
    if (charIdx >= range.startIdx && charIdx <= range.endIdx) {
      return range.translation;
    }
  }
  return null;
}

/**
 * Render minimalistic caption with colored character spans
 * @param {HTMLElement} displayEl - The display element to render into
 * @param {string} text - The caption text
 * @param {Object} mmState - Minimalistic mode state
 */
export function renderMinimalisticCaption(displayEl, text, mmState) {
  const { processedUpTo, processingUpTo, wordBoundaries, sentenceRanges } = mmState;

  let html = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const escapedChar = char.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    let className = 'mm-char';
    let dataAttrs = '';

    if (i < processedUpTo) {
      // Processed - find word info and apply color
      const wordInfo = findWordForIndex(i, wordBoundaries);
      if (wordInfo) {
        const typeClass = getWordTypeClass(wordInfo.type);
        className += ` mm-type-${typeClass}`;

        // Add tooltip data
        const tooltip = `${wordInfo.romaji} - ${wordInfo.english}`;
        dataAttrs += ` data-tooltip="${tooltip.replace(/"/g, '&quot;')}"`;
      } else {
        className += ' mm-type-other';
      }

      // Check if this is a sentence-ending period
      if (char === '。' || char === '！' || char === '？') {
        const sentenceTranslation = findSentenceForIndex(i, sentenceRanges);
        if (sentenceTranslation) {
          className += ' mm-sentence-end';
          dataAttrs += ` data-sentence-translation="${sentenceTranslation.replace(/"/g, '&quot;')}"`;
        }
      }
    } else if (i < processingUpTo) {
      // Processing - gray with pulse
      className += ' mm-processing';
    } else {
      // Pending - white
      className += ' mm-pending';
    }

    html += `<span class="${className}"${dataAttrs}>${escapedChar}</span>`;
  }

  displayEl.innerHTML = html;
}

/**
 * Build word boundaries from breakdown data
 * @param {string} text - Original text
 * @param {Array} words - Words from breakdown API
 * @returns {Array} - Array of {startIdx, endIdx, word}
 */
function buildWordBoundaries(text, words) {
  const boundaries = [];
  let searchStart = 0;

  for (const word of words) {
    const idx = text.indexOf(word.japanese, searchStart);
    if (idx !== -1) {
      boundaries.push({
        startIdx: idx,
        endIdx: idx + word.japanese.length,
        word: word
      });
      searchStart = idx + word.japanese.length;
    }
  }

  return boundaries;
}

/**
 * Build sentence ranges from text and translation
 * @param {string} text - Original text
 * @param {string} translation - Full translation
 * @returns {Array} - Array of {startIdx, endIdx, translation}
 */
function buildSentenceRanges(text, translation) {
  const ranges = [];
  const sentenceEnders = /[。！？]/g;
  let lastEnd = 0;
  let match;

  while ((match = sentenceEnders.exec(text)) !== null) {
    ranges.push({
      startIdx: lastEnd,
      endIdx: match.index,
      translation: translation // For now, use full translation
    });
    lastEnd = match.index + 1;
  }

  // Handle text without sentence enders
  if (ranges.length === 0 && text.length > 0) {
    ranges.push({
      startIdx: 0,
      endIdx: text.length - 1,
      translation: translation
    });
  }

  return ranges;
}

/**
 * Initialize minimalistic mode container
 * @param {HTMLElement} container - Caption container
 * @param {HTMLElement} messageEl - Original message element
 * @param {string} text - Caption text
 * @param {string} speaker - Speaker name
 */
export function initializeMinimalisticContainer(container, messageEl, text, speaker) {
  debugLog('MM-INIT', `Initializing minimalistic mode for: "${text.slice(0, 40)}..."`);

  // Mark container as having minimalistic mode active
  container.setAttribute('data-mm-active', 'true');

  // Create display element for colored text
  const displayEl = document.createElement('span');
  displayEl.className = 'mm-display';
  displayEl.setAttribute('data-mm-display', 'true');

  // Hide original element
  hideOriginalElement(messageEl);

  // Insert display element after hidden original
  messageEl.insertAdjacentElement('afterend', displayEl);

  // Generate content key
  const contentKey = generateContentKey(speaker, text, getTimeBucket());

  // Initialize state
  const mmState = {
    processedUpTo: 0,
    processingUpTo: text.length, // Mark all as processing initially
    wordBoundaries: [],
    sentenceRanges: [],
    processTimer: null
  };

  // Store state
  translationState.set(container, {
    originalText: text,
    originalEl: messageEl.cloneNode(true),
    translatedText: null,
    translatedEl: displayEl,
    contentKey,
    lastTranslatedLength: 0,
    shadowOriginalEl: messageEl,
    speakerName: speaker,
    isIncremental: true,
    breakdownData: null,
    isExpanded: true,
    minimalisticState: mmState
  });

  // Mark as active
  activeContentKeys.add(contentKey);

  // Render initial state (all processing)
  renderMinimalisticCaption(displayEl, text, mmState);

  // Start processing
  processMinimalisticText(container, text, speaker);
}

/**
 * Process text for minimalistic mode via API
 * @param {HTMLElement} container - Caption container
 * @param {string} text - Text to process
 * @param {string} speaker - Speaker name
 */
async function processMinimalisticText(container, text, speaker) {
  const state = translationState.get(container);
  if (!state?.minimalisticState) return;

  // Check cache first
  const cached = findCachedTranslation(speaker, text);
  if (cached?.breakdownData) {
    debugLog('MM-CACHE', 'Using cached breakdown data');
    applyMinimalisticBreakdown(container, text, cached.breakdownData);
    return;
  }

  debugLog('MM-API', `Processing text: "${text.slice(0, 40)}..."`);

  try {
    const breakdownData = await analyzeJapaneseWithGemini(text);

    // Check if container still exists and is in minimalistic mode
    if (!translationState.has(container)) {
      debugLog('MM-API', 'Container removed during processing');
      return;
    }

    const currentState = translationState.get(container);
    if (!currentState?.minimalisticState) {
      debugLog('MM-API', 'Mode changed during processing');
      return;
    }

    // Cache the result
    const contentKey = currentState.contentKey;
    import('../core/state.js').then(({ translationCache }) => {
      translationCache.set(contentKey, {
        translatedText: breakdownData.translation,
        breakdownData: breakdownData,
        timestamp: Date.now(),
        speaker,
        originalText: text
      });
    });
    cacheBreakdown(text, breakdownData);

    // Apply the breakdown
    applyMinimalisticBreakdown(container, text, breakdownData);

  } catch (error) {
    debugLog('MM-API', 'Error:', error.message);

    // On error, show text as pending (white)
    if (translationState.has(container)) {
      const currentState = translationState.get(container);
      if (currentState?.minimalisticState) {
        currentState.minimalisticState.processingUpTo = 0;
        renderMinimalisticCaption(currentState.translatedEl, text, currentState.minimalisticState);
      }
    }
  }
}

/**
 * Apply breakdown data to minimalistic display
 * @param {HTMLElement} container - Caption container
 * @param {string} text - Original text
 * @param {Object} breakdownData - Breakdown from API
 */
function applyMinimalisticBreakdown(container, text, breakdownData) {
  const state = translationState.get(container);
  if (!state?.minimalisticState) return;

  const mmState = state.minimalisticState;

  // Build word boundaries
  mmState.wordBoundaries = buildWordBoundaries(text, breakdownData.words);

  // Build sentence ranges
  mmState.sentenceRanges = buildSentenceRanges(text, breakdownData.translation);

  // Mark all as processed
  mmState.processedUpTo = text.length;
  mmState.processingUpTo = text.length;

  // Update state
  state.breakdownData = breakdownData;
  state.translatedText = breakdownData.translation;
  state.lastTranslatedLength = text.length;

  // Re-render with colors
  renderMinimalisticCaption(state.translatedEl, text, mmState);

  // Record word frequencies
  if (state.contentKey && breakdownData.words) {
    recordWordFrequencies(breakdownData.words, state.contentKey);
  }

  debugLog('MM-APPLY', `Applied breakdown: ${breakdownData.words.length} words`);
}

/**
 * Handle text updates in minimalistic mode
 * @param {HTMLElement} container - Caption container
 * @param {string} newText - Updated text
 */
export function handleMinimalisticTextUpdate(container, newText) {
  const state = translationState.get(container);
  if (!state?.minimalisticState) return;

  const mmState = state.minimalisticState;
  const oldText = state.originalText;

  // Check if text actually changed
  if (newText === oldText) return;

  debugLog('MM-UPDATE', `Text changed: "${oldText.slice(-20)}" -> "${newText.slice(-20)}"`);

  // If new text is appended
  if (newText.startsWith(oldText)) {
    // Keep existing processed chars, mark new ones as pending
    // processingUpTo stays at oldText.length (already processed portion)
    // New characters will be white (pending)
    state.originalText = newText;

    // Re-render with new text
    renderMinimalisticCaption(state.translatedEl, newText, mmState);

    // Debounce API call for new text
    if (mmState.processTimer) {
      clearTimeout(mmState.processTimer);
    }

    mmState.processTimer = setTimeout(() => {
      // Reprocess entire text to get full breakdown
      processMinimalisticText(container, newText, state.speakerName);
    }, 500);
  } else {
    // Text changed significantly - reset and reprocess
    debugLog('MM-UPDATE', 'Text changed significantly, reprocessing');

    mmState.processedUpTo = 0;
    mmState.processingUpTo = newText.length;
    mmState.wordBoundaries = [];
    mmState.sentenceRanges = [];

    state.originalText = newText;
    state.breakdownData = null;

    // Re-render as processing
    renderMinimalisticCaption(state.translatedEl, newText, mmState);

    // Process new text
    if (mmState.processTimer) {
      clearTimeout(mmState.processTimer);
    }

    mmState.processTimer = setTimeout(() => {
      processMinimalisticText(container, newText, state.speakerName);
    }, 300);
  }
}

/**
 * Remove minimalistic mode overlay and clean up
 * @param {HTMLElement} container - Caption container
 */
export function removeMinimalisticOverlay(container) {
  const state = translationState.get(container);

  // Cancel any pending processing
  if (state?.minimalisticState?.processTimer) {
    clearTimeout(state.minimalisticState.processTimer);
  }

  // Remove mm-active attribute
  container.removeAttribute('data-mm-active');

  // Remove display element and restore original
  if (state?.translatedEl) {
    state.translatedEl.remove();
  }

  if (state?.shadowOriginalEl) {
    state.shadowOriginalEl.style.cssText = '';
    state.shadowOriginalEl.removeAttribute('data-shadow-original');
  }

  // Clear from active keys
  if (state?.contentKey) {
    activeContentKeys.delete(state.contentKey);
  }

  translationState.delete(container);
  debugLog('MM-REMOVE', 'Minimalistic overlay removed');
}

/**
 * Handle caption click in minimalistic mode
 * @param {Event} event
 * @param {HTMLElement} container
 * @param {Function} removeOverlay - Function to remove panel overlay
 */
export function handleMinimalisticCaptionClick(event, container, removeOverlay) {
  // If already has minimalistic state, toggle off
  if (translationState.has(container)) {
    const state = translationState.get(container);

    // Check if it's a minimalistic mode container
    if (state.minimalisticState) {
      // Check for new text to process
      const currentText = state.shadowOriginalEl?.textContent?.trim() || '';
      if (currentText.length > state.originalText.length && currentText.startsWith(state.originalText)) {
        // New text available, reprocess
        debugLog('MM-CLICK', 'New text detected, reprocessing');
        handleMinimalisticTextUpdate(container, currentText);
        return;
      }

      // Toggle off
      debugLog('MM-CLICK', 'Toggling off minimalistic overlay');
      removeMinimalisticOverlay(container);
      return;
    } else {
      // Has panel mode state - remove it first
      removeOverlay(container);
    }
  }

  // Find the message element
  const messageEl = container.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original]):not([data-mm-display])');
  if (!messageEl) return;

  const originalText = messageEl.textContent?.trim();
  if (!originalText) return;

  // Get speaker name
  const nameEl = container.querySelector('.NWpY1d');
  const speaker = nameEl?.textContent?.trim() || '(unknown)';

  debugLog('MM-CLICK', `Activating minimalistic mode for: "${originalText.slice(0, 40)}..."`);

  // Initialize minimalistic mode for this container
  initializeMinimalisticContainer(container, messageEl, originalText, speaker);
}
