import { debugLog } from '../core/debug.js';
import {
  inlineBreakdownState,
  translationCache,
  activeContentKeys
} from '../core/state.js';
import { getWordTypeClass } from '../utils/text.js';
import { findCachedTranslation, generateContentKey, getTimeBucket, cacheBreakdown } from '../core/cache.js';
import { analyzeJapaneseWithGemini } from '../core/api.js';
import { cacheWords } from '../core/word-cache.js';
import { forceHideTooltip } from './word-tooltip.js';
import { getPreHighlightHTML as getChatPreHighlightHTML } from './word-highlight.js';
import { getPreHighlightHTML as getRedminePreHighlightHTML } from '../redmine/word-highlight.js';
import { getPreHighlightHTML as getGmailPreHighlightHTML } from '../gmail/word-highlight.js';

/**
 * Remove the loading indicator.
 * Safe to call even if no indicator exists.
 * @param {HTMLElement} messageEl - Message element
 */
function cleanupLoadingIndicator(messageEl) {
  const state = inlineBreakdownState.get(messageEl);
  if (state?.loadingIndicator) {
    state.loadingIndicator.remove();
    state.loadingIndicator = null;
  }
}

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

  // Clear tooltip before showing breakdown
  forceHideTooltip();

  // Save original HTML if not already saved (prefer pre-highlight version)
  if (!existingState?.originalHTML) {
    const trueOriginal = getChatPreHighlightHTML(messageEl)
      || getRedminePreHighlightHTML(messageEl)
      || getGmailPreHighlightHTML(messageEl)
      || messageEl.innerHTML;
    inlineBreakdownState.set(messageEl, {
      originalHTML: trueOriginal,
      breakdownData: null,
      isShowingBreakdown: true
    });
  }

  // Show loading indicator — append inside the message so the dots
  // appear inline at the end of the text, inside the bubble.
  const indicator = document.createElement('span');
  indicator.className = 'gcwb-loading-indicator';
  indicator.innerHTML = '<span class="gcwb-dot"></span><span class="gcwb-dot"></span><span class="gcwb-dot"></span>';
  messageEl.appendChild(indicator);

  // Store indicator reference so we can remove it later
  const stateAfterIndicator = inlineBreakdownState.get(messageEl);
  if (stateAfterIndicator) {
    stateAfterIndicator.loadingIndicator = indicator;
  }

  // Analyze the text
  try {
    const breakdownData = await analyzeJapaneseWithGemini(text);

    // Check if message was restored during analysis
    const currentState = inlineBreakdownState.get(messageEl);
    if (!currentState?.isShowingBreakdown) {
      cleanupLoadingIndicator(messageEl);
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
      cacheBreakdown(text, breakdownData);
      activeContentKeys.add(contentKey);
      debugLog('GCWB-INLINE', `Cached breakdown: ${contentKey.slice(0, 40)}`);

      // Persist individual words to word cache for future highlighting
      if (breakdownData.words && breakdownData.words.length > 0) {
        cacheWords(breakdownData.words);
      }
    }

    // Update state with breakdown data
    inlineBreakdownState.set(messageEl, {
      ...currentState,
      breakdownData: breakdownData
    });

    // Remove the analyzing overlay before rendering the final breakdown
    cleanupLoadingIndicator(messageEl);

    // Render the breakdown
    renderInlineContent(messageEl, breakdownData);
  } catch (error) {
    const currentState = inlineBreakdownState.get(messageEl);
    if (!currentState?.isShowingBreakdown) return;

    // Remove the analyzing overlay before showing the error
    cleanupLoadingIndicator(messageEl);

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
  // Clear tooltip before showing breakdown
  forceHideTooltip();

  // Save original HTML if not already saved (prefer pre-highlight version)
  const existingState = inlineBreakdownState.get(messageEl);
  if (!existingState?.originalHTML) {
    const trueOriginal = getChatPreHighlightHTML(messageEl)
      || getRedminePreHighlightHTML(messageEl)
      || getGmailPreHighlightHTML(messageEl)
      || messageEl.innerHTML;
    inlineBreakdownState.set(messageEl, {
      originalHTML: trueOriginal,
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
    const readingText = (word.reading || '').trim() || word.japanese;
    const romajiText = (word.romaji || '').trim() || '-';
    const englishText = (word.english || '').trim() || '-';

    return `
      <span class="gcwb-word" data-word="${escapeHtml(word.japanese)}"
            data-reading="${escapeHtml(readingText)}"
            data-romaji="${escapeHtml(romajiText)}"
            data-english="${escapeHtml(englishText)}"
            data-type="${escapeHtml(typeClass)}"
            style="animation-delay: ${index * 0.03}s">
        <span class="gcwb-word-text gcwb-type-${typeClass}">${escapeHtml(word.japanese)}</span>
      </span>
    `;
  }).join('');

  const translation = breakdownData.translation || '';
  const translationDelay = (breakdownData.words.length * 0.03) + 0.1;
  const translationHtml = translation ? `
      <div class="gcwb-inline-translation" style="animation-delay: ${translationDelay}s">
        <span class="gcwb-translation-text">"${escapeHtml(translation)}"</span>
      </div>
  ` : '';

  messageEl.innerHTML = `
    <div class="gcwb-inline-container">
      <div class="gcwb-inline-header">
        <button class="gcwb-toggle-btn" data-action="restore">↩ Original</button>
      </div>
      <div class="gcwb-inline-words">${wordsHtml}</div>
      ${translationHtml}
    </div>
  `;

  setupInlineHandlers(messageEl, breakdownData);
}

// Active inline popover state
let activePopover = null;
let popoverHideTimeout = null;
const POPOVER_SHOW_DELAY = 150;
const POPOVER_HIDE_DELAY = 100;

/**
 * Create and show a body-appended popover for a word element
 * @param {HTMLElement} wordEl - The .gcwb-word element
 */
function showInlinePopover(wordEl) {
  // Clear any pending hide
  if (popoverHideTimeout) {
    clearTimeout(popoverHideTimeout);
    popoverHideTimeout = null;
  }

  // Remove existing popover
  hideInlinePopoverImmediate();

  const word = wordEl.dataset.word;
  const reading = wordEl.dataset.reading;
  const romaji = wordEl.dataset.romaji;
  const english = wordEl.dataset.english;
  const typeClass = wordEl.dataset.type;

  if (!word) return;

  // Create popover element
  const popover = document.createElement('div');
  popover.className = 'gcwb-word-popover';

  popover.innerHTML = `
    <div class="gcwb-popover-arrow"></div>
    <div class="gcwb-popover-content">
      <div class="gcwb-popover-reading gcwb-type-${typeClass}">${escapeHtml(reading || word)}</div>
      <div class="gcwb-popover-romaji">${escapeHtml(romaji || word)}</div>
      <div class="gcwb-popover-meaning">${escapeHtml(english || word)}</div>
    </div>
  `;

  document.body.appendChild(popover);
  activePopover = popover;

  // Position using getBoundingClientRect (correct since popover is on body)
  const wordRect = wordEl.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();

  let left = wordRect.left + (wordRect.width / 2) - (popoverRect.width / 2);
  let top = wordRect.top - popoverRect.height - 8;

  const padding = 8;
  if (left < padding) left = padding;
  if (left + popoverRect.width > window.innerWidth - padding) {
    left = window.innerWidth - popoverRect.width - padding;
  }

  if (top < padding) {
    top = wordRect.bottom + 8;
    popover.classList.add('gcwb-popover-below');
  }

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  // Allow hovering the popover itself
  popover.addEventListener('mouseenter', () => {
    if (popoverHideTimeout) {
      clearTimeout(popoverHideTimeout);
      popoverHideTimeout = null;
    }
  });
  popover.addEventListener('mouseleave', () => {
    scheduleHidePopover();
  });
}

/**
 * Schedule hiding the popover after a short delay
 */
function scheduleHidePopover() {
  popoverHideTimeout = setTimeout(() => {
    hideInlinePopoverImmediate();
  }, POPOVER_HIDE_DELAY);
}

/**
 * Immediately remove the active popover
 */
function hideInlinePopoverImmediate() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
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

  // Translation click-to-copy
  const translationEl = messageEl.querySelector('.gcwb-inline-translation');
  if (translationEl) {
    translationEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = breakdownData.translation || '';
      navigator.clipboard.writeText(text).then(() => {
        translationEl.classList.add('gcwb-copied');
        setTimeout(() => translationEl.classList.remove('gcwb-copied'), 1500);
      });
    });
  }

  // Word hover for body-appended popover and click to copy
  messageEl.querySelectorAll('.gcwb-word').forEach(wordEl => {
    let showTimeout;

    wordEl.addEventListener('mouseenter', () => {
      showTimeout = setTimeout(() => {
        showInlinePopover(wordEl);
      }, POPOVER_SHOW_DELAY);
    });

    wordEl.addEventListener('mouseleave', () => {
      clearTimeout(showTimeout);
      scheduleHidePopover();
    });

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
    // Remove analyzing overlay if it's still present (e.g. restored during loading)
    cleanupLoadingIndicator(messageEl);
    // Clean up any body-appended popover
    hideInlinePopoverImmediate();
    messageEl.innerHTML = state.originalHTML;
    inlineBreakdownState.set(messageEl, {
      ...state,
      isShowingBreakdown: false
    });
    debugLog('GCWB-INLINE', 'Restored original content');
    messageEl.dispatchEvent(new CustomEvent('gcwb-content-restored', { bubbles: true }));
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
