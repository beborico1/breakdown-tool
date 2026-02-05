import { debugLog } from '../core/debug.js';
import {
  inlineBreakdownState,
  translationCache,
  activeContentKeys
} from '../core/state.js';
import { getWordTypeClass } from '../utils/text.js';
import { findCachedTranslation, generateContentKey, getTimeBucket } from '../core/cache.js';
import { analyzeJapaneseWithGemini } from '../core/api.js';

/**
 * Show inline breakdown for a message, replacing its content
 * @param {HTMLElement} messageEl - Message element to replace
 * @param {string} text - Text to analyze
 */
export async function showInlineBreakdown(messageEl, text) {
  // Check if already showing breakdown for this message
  const existingState = inlineBreakdownState.get(messageEl);
  if (existingState?.isShowingBreakdown) {
    // Already showing - if we have cached data, just return
    if (existingState.breakdownData) {
      debugLog('GCWB-INLINE', 'Already showing breakdown');
      return;
    }
  }

  // Check cache first
  const cached = findCachedTranslation('GCWB', text);
  if (cached?.breakdownData) {
    debugLog('GCWB-INLINE', 'Using cached breakdown');
    showCachedInline(messageEl, cached.breakdownData);
    return;
  }

  // Save original HTML if not already saved
  if (!existingState?.originalHTML) {
    inlineBreakdownState.set(messageEl, {
      originalHTML: messageEl.innerHTML,
      breakdownData: null,
      isShowingBreakdown: true
    });
  }

  // Show loading state - append indicator instead of replacing
  const loadingIndicator = document.createElement('div');
  loadingIndicator.className = 'gcwb-inline-loading-indicator';
  loadingIndicator.innerHTML = '<span class="gcwb-spinner"></span>';
  messageEl.appendChild(loadingIndicator);

  // Analyze the text
  try {
    const breakdownData = await analyzeJapaneseWithGemini(text);

    // Check if message was restored during analysis
    const currentState = inlineBreakdownState.get(messageEl);
    if (!currentState?.isShowingBreakdown) {
      debugLog('GCWB-INLINE', 'Message restored during analysis, aborting');
      return;
    }

    // Cache the result
    if (breakdownData && !breakdownData.truncated) {
      const contentKey = generateContentKey('GCWB', text, getTimeBucket());
      translationCache.set(contentKey, {
        translatedText: breakdownData.translation,
        breakdownData: breakdownData,
        timestamp: Date.now(),
        speaker: 'GCWB',
        originalText: text
      });
      activeContentKeys.add(contentKey);
      debugLog('GCWB-INLINE', `Cached breakdown: ${contentKey.slice(0, 40)}`);
    }

    // Update state with breakdown data
    inlineBreakdownState.set(messageEl, {
      ...currentState,
      breakdownData: breakdownData
    });

    // Remove loading indicator
    const loader = messageEl.querySelector('.gcwb-inline-loading-indicator');
    if (loader) loader.remove();

    // Render the breakdown
    renderInlineContent(messageEl, breakdownData);
  } catch (error) {
    const currentState = inlineBreakdownState.get(messageEl);
    if (!currentState?.isShowingBreakdown) return;

    // Remove loading indicator
    const loader = messageEl.querySelector('.gcwb-inline-loading-indicator');
    if (loader) loader.remove();

    messageEl.innerHTML = `
      <div class="gcwb-inline-container">
        <div class="gcwb-inline-header">
          <button class="gcwb-toggle-btn" data-action="restore">↩ Original</button>
        </div>
        <div class="gcwb-inline-error">
          <div class="gcwb-error-message">Error: ${error.message}</div>
          <button class="gcwb-retry-btn" data-action="retry">Retry</button>
        </div>
      </div>
    `;

    setupErrorHandlers(messageEl, text);
  }
}

/**
 * Show cached breakdown inline (no loading state needed)
 * @param {HTMLElement} messageEl - Message element
 * @param {Object} breakdownData - Cached breakdown data
 */
function showCachedInline(messageEl, breakdownData) {
  // Save original HTML if not already saved
  const existingState = inlineBreakdownState.get(messageEl);
  if (!existingState?.originalHTML) {
    inlineBreakdownState.set(messageEl, {
      originalHTML: messageEl.innerHTML,
      breakdownData: breakdownData,
      isShowingBreakdown: true
    });
  } else {
    inlineBreakdownState.set(messageEl, {
      ...existingState,
      breakdownData: breakdownData,
      isShowingBreakdown: true
    });
  }

  renderInlineContent(messageEl, breakdownData);
}

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Render inline breakdown content
 * @param {HTMLElement} messageEl - Message element
 * @param {Object} breakdownData - Breakdown data from API
 */
function renderInlineContent(messageEl, breakdownData) {
  const wordsHtml = breakdownData.words.map((word, index) => {
    const typeClass = getWordTypeClass(word.type);
    const readingText = word.reading || word.japanese;

    return `
      <span class="gcwb-word" data-word="${escapeHtml(word.japanese)}"
            style="animation-delay: ${index * 0.03}s">
        <span class="gcwb-word-text gcwb-type-${typeClass}">${escapeHtml(word.japanese)}</span>
        <div class="gcwb-word-popover">
          <div class="gcwb-popover-arrow"></div>
          <div class="gcwb-popover-content">
            <div class="gcwb-popover-reading">${escapeHtml(readingText)}</div>
            <div class="gcwb-popover-romaji">${escapeHtml(word.romaji)}</div>
            <div class="gcwb-popover-meaning">${escapeHtml(word.english)}</div>
          </div>
        </div>
      </span>
    `;
  }).join('');

  messageEl.innerHTML = `
    <div class="gcwb-inline-container">
      <div class="gcwb-inline-header">
        <button class="gcwb-toggle-btn" data-action="restore">↩ Original</button>
      </div>
      <div class="gcwb-inline-words">${wordsHtml}</div>
      <div class="gcwb-inline-translation">"${escapeHtml(breakdownData.translation)}"</div>
    </div>
  `;

  setupInlineHandlers(messageEl, breakdownData);
}

/**
 * Set up event handlers for inline breakdown
 * @param {HTMLElement} messageEl - Message element
 * @param {Object} breakdownData - Breakdown data
 */
function setupInlineHandlers(messageEl, breakdownData) {
  // Toggle button to restore original
  const toggleBtn = messageEl.querySelector('[data-action="restore"]');
  toggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    restoreOriginalContent(messageEl);
  });

  // Copy buttons
  messageEl.querySelectorAll('.gcwb-inline-copy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const copyType = e.target.dataset.copy;
      handleInlineCopy(copyType, breakdownData, e.target);
    });
  });

  // Word click to copy
  messageEl.querySelectorAll('.gcwb-word').forEach(wordEl => {
    wordEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const word = wordEl.dataset.word;
      navigator.clipboard.writeText(word).then(() => {
        wordEl.classList.add('gcwb-copied');
        setTimeout(() => wordEl.classList.remove('gcwb-copied'), 1500);
      });
    });
  });
}

/**
 * Set up error state handlers
 * @param {HTMLElement} messageEl - Message element
 * @param {string} text - Original text for retry
 */
function setupErrorHandlers(messageEl, text) {
  const restoreBtn = messageEl.querySelector('[data-action="restore"]');
  restoreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    restoreOriginalContent(messageEl);
  });

  const retryBtn = messageEl.querySelector('[data-action="retry"]');
  retryBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    showInlineBreakdown(messageEl, text);
  });
}

/**
 * Restore original message content
 * @param {HTMLElement} messageEl - Message element
 */
export function restoreOriginalContent(messageEl) {
  const state = inlineBreakdownState.get(messageEl);
  if (state?.originalHTML) {
    messageEl.innerHTML = state.originalHTML;
    inlineBreakdownState.set(messageEl, {
      ...state,
      isShowingBreakdown: false
    });
    debugLog('GCWB-INLINE', 'Restored original content');
  }
}

/**
 * Handle copy action from inline buttons
 * @param {string} type - Copy type (japanese, romaji, english)
 * @param {Object} breakdownData - Breakdown data
 * @param {HTMLElement} button - Button element for feedback
 */
function handleInlineCopy(type, breakdownData, button) {
  let text;
  switch (type) {
    case 'japanese':
      text = breakdownData.original;
      break;
    case 'romaji':
      text = breakdownData.words.map(w => w.romaji).join(' ');
      break;
    case 'english':
      text = breakdownData.translation;
      break;
    default:
      return;
  }

  navigator.clipboard.writeText(text).then(() => {
    const originalText = button.textContent;
    button.textContent = 'Copied!';
    button.classList.add('gcwb-copied');
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('gcwb-copied');
    }, 1500);
    debugLog('GCWB-INLINE', `Copied ${type}: ${text.slice(0, 50)}`);
  }).catch(err => {
    debugLog('GCWB-INLINE', 'Copy failed:', err.message);
  });
}
