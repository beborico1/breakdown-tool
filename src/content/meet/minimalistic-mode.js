import { debugLog } from '../core/debug.js';
import {
  minimalisticModeEnabled,
  setMinimalisticModeEnabled,
  translationState,
  translationCache,
  activeContentKeys
} from '../core/state.js';
import { getWordTypeClass } from '../utils/text.js';
import { findCachedTranslation, generateContentKey, getTimeBucket, cacheBreakdown } from '../core/cache.js';
import { analyzeJapaneseWithGemini } from '../core/api.js';
import { recordWordFrequencies } from '../services/frequency-tracker.js';
import { attachHoverListeners, detachHoverListeners } from './hover-card.js';

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
 * Build word boundaries from breakdown data by scanning for each word's
 * Japanese form in the original text. Words that don't match (rare, e.g.
 * Gemini returned a normalized form) are skipped.
 * @param {string} text
 * @param {Array} words
 * @returns {Array<{startIdx: number, endIdx: number, word: Object}>}
 */
export function buildWordBoundaries(text, words) {
  const boundaries = [];
  let searchStart = 0;

  for (const word of words) {
    if (!word?.japanese) continue;
    const idx = text.indexOf(word.japanese, searchStart);
    if (idx !== -1) {
      boundaries.push({
        startIdx: idx,
        endIdx: idx + word.japanese.length,
        word,
      });
      searchStart = idx + word.japanese.length;
    }
  }

  return boundaries;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Paint the original caption element with colored spans per word, preserving
 * the visible text exactly.
 * @param {HTMLElement} messageEl - The .ygicle.VbkSUe element
 * @param {string} text - Original text
 * @param {Array} words - Words from breakdown API
 */
export function paintWordColoring(messageEl, text, words) {
  if (!messageEl || !text) return;
  const boundaries = buildWordBoundaries(text, words || []);

  let html = '';
  let i = 0;
  let bIdx = 0;
  let prevType = null;
  let tone = 0;

  while (i < text.length) {
    const boundary = boundaries[bIdx];
    if (boundary && i === boundary.startIdx) {
      const word = boundary.word;
      const typeClass = getWordTypeClass(word.type);
      const segment = text.slice(boundary.startIdx, boundary.endIdx);
      const tooltip = `${word.romaji || ''}${word.english ? ' - ' + word.english : ''}`;
      tone = (word.type && word.type === prevType) ? 1 - tone : 0;
      const toneClass = tone === 1 ? ' mm-tone-alt' : '';
      prevType = word.type;
      html += `<span class="mm-word mm-type-${typeClass}${toneClass}" data-tooltip="${escapeHtml(tooltip)}">${escapeHtml(segment)}</span>`;
      i = boundary.endIdx;
      bIdx++;
    } else {
      html += escapeHtml(text[i]);
      i++;
      prevType = null;
      tone = 0;
    }
  }

  messageEl.innerHTML = html;
  messageEl.setAttribute('data-mm-colored', 'true');
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
  // element while we're waiting on Gemini. The marker stays across paint.
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

  try {
    const breakdownData = await analyzeJapaneseWithGemini(text);

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
    // On failure, leave the caption untouched — no coloring, no card, no UI noise.
    removeMinimalisticOverlay(container);
  }
}

function applyBreakdown(container, messageEl, text, breakdownData, speaker) {
  const state = translationState.get(container);
  if (!state) return;

  state.breakdownData = breakdownData;
  state.translatedText = breakdownData.translation;

  paintWordColoring(messageEl, text, breakdownData.words);
  attachHoverListeners(container, breakdownData);

  if (state.contentKey && breakdownData.words) {
    recordWordFrequencies(breakdownData.words, state.contentKey);
  }

  debugLog('MM-APPLY', `Painted ${breakdownData.words.length} words`);
}

/**
 * Tear down minimalistic state for a container. Used when the container is
 * removed from the DOM or when the mode is disabled via storage.
 */
export function removeMinimalisticOverlay(container) {
  const state = translationState.get(container);

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
