import { count, markOnce } from '../../metrics/index.js';
import { M, F } from '../../metrics/events.js';
import { debugLog } from '../core/debug.js';
import { getWordTypeClass } from '../utils/text.js';
import { isPageLightMode } from '../utils/dom.js';

/**
 * Word Tooltip Module
 * Shows meaning on hover over cached/highlighted/auto words. Works on any site,
 * so it builds DOM with createElement/textContent (no innerHTML) to stay safe
 * under strict CSP / Trusted Types policies.
 */

// Active tooltip element
let activeTooltip = null;
let hideTimeout = null;
let listenersBound = false;
const HIDE_DELAY_MS = 100;

/**
 * Bumped every time the visible tooltip changes. A clause translation resolves
 * asynchronously, so its handler compares the generation it captured against
 * this before touching the DOM; a stale reply then lands on nothing.
 */
let tooltipGeneration = 0;

/**
 * Clause translation is injected rather than imported so this module keeps no
 * chrome dependency and stays loadable in the DOM test harness.
 * @type {{translate: (clause: string) => Promise<string>, warm: () => void}|null}
 */
let clauseTranslator = null;

/** Pointer dwell before a hover is worth a translation request. */
const CLAUSE_HOVER_DWELL_MS = 150;
let clauseDwellTimer = null;

function cancelClauseDwell() {
  if (clauseDwellTimer) {
    clearTimeout(clauseDwellTimer);
    clauseDwellTimer = null;
  }
}

/**
 * Small DOM builder: create an element with an optional class and text content.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== '') node.textContent = text;
  return node;
}

/**
 * Show the tooltip for a clause-boundary dot.
 *
 * A dot knows its own clause, so when no translation is cached it renders a
 * pending line and fills it in when the request resolves. Nothing is shown for a
 * dot that has neither, which keeps the pre-clause behaviour for any dot painted
 * without clause data.
 * @param {HTMLElement} dotEl
 */
// Hover fires constantly while reading, so it is sampled by time rather than
// counted per event: one count per 500 ms of hovering is enough to size the
// behaviour without turning a reading session into thousands of increments.
let lastHoverCount = 0;
function countHover() {
  const now = Date.now();
  if (now - lastHoverCount < 500) return;
  lastHoverCount = now;
  count(M.HOVER_SHOWN);
  markOnce(F.FIRST_HOVER);
}

function showBoundaryTooltip(dotEl) {
  countHover();
  const clause = dotEl.dataset.clause || '';
  const english = dotEl.dataset.english || '';
  if (!english && !(clause && clauseTranslator)) return;

  const tooltip = el('div', 'gcwb-word-tooltip gcwb-boundary-tooltip');
  if (isPageLightMode(dotEl)) tooltip.classList.add('gcwb-light');
  const content = el('div', 'gcwb-tooltip-content');
  const meaning = el('div', 'gcwb-tooltip-meaning gcwb-boundary-meaning',
    english || '...');
  if (!english) meaning.classList.add('gcwb-boundary-pending');
  content.appendChild(meaning);
  tooltip.appendChild(content);
  tooltip.appendChild(el('div', 'gcwb-tooltip-arrow'));
  document.body.appendChild(tooltip);
  activeTooltip = tooltip;
  positionTooltip(tooltip, dotEl);

  if (english || !clause || !clauseTranslator) {
    debugLog('WORD-TOOLTIP', 'Showing boundary translation tooltip');
    return;
  }

  clauseTranslator.warm();
  const generation = tooltipGeneration;
  clauseDwellTimer = setTimeout(() => {
    clauseDwellTimer = null;
    clauseTranslator.translate(clause).then((result) => {
      if (generation !== tooltipGeneration || !tooltip.isConnected) return;
      if (!result) {
        meaning.textContent = 'Translation unavailable';
        return;
      }
      // Cache on the dot so a second hover renders instantly. Safe to write:
      // the universal observer watches childList and characterData, not
      // attributes, so this cannot feed back into a rescan.
      dotEl.dataset.english = result;
      meaning.textContent = result;
      meaning.classList.remove('gcwb-boundary-pending');
      // The box just changed height, so it may no longer fit where it was put.
      positionTooltip(tooltip, dotEl);
    });
  }, CLAUSE_HOVER_DWELL_MS);
}

/**
 * Create and show tooltip for a word element
 * @param {HTMLElement} wordEl - The highlighted word span
 */
function showTooltip(wordEl) {
  countHover();
  // Clear any pending hide
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  cancelClauseDwell();
  tooltipGeneration++;

  // Remove existing tooltip
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }

  // Clause-boundary dot: shows the translation of its own clause and nothing
  // else. These spans carry data-clause and data-english but no data-word.
  if (wordEl.classList?.contains('gcwb-auto-boundary')) {
    showBoundaryTooltip(wordEl);
    return;
  }

  // Get word data from element attributes
  const word = wordEl.dataset.word;
  const reading = wordEl.dataset.reading;
  const romaji = wordEl.dataset.romaji;
  const english = wordEl.dataset.english;
  const type = wordEl.dataset.type;

  if (!word) return;

  // Create tooltip element
  const tooltip = el('div', 'gcwb-word-tooltip');
  if (isPageLightMode(wordEl)) tooltip.classList.add('gcwb-light');

  const typeClass = getWordTypeClass(type);
  const readingDisplay = reading && reading !== word ? reading : '';

  const content = el('div', 'gcwb-tooltip-content');
  content.appendChild(el('div', `gcwb-tooltip-japanese gcwb-type-${typeClass}`, word));
  if (readingDisplay) content.appendChild(el('div', 'gcwb-tooltip-reading', readingDisplay));
  if (romaji) content.appendChild(el('div', 'gcwb-tooltip-romaji', romaji));
  if (english) content.appendChild(el('div', 'gcwb-tooltip-meaning', english));
  if (type) content.appendChild(el('div', 'gcwb-tooltip-type', type));
  tooltip.appendChild(content);
  tooltip.appendChild(el('div', 'gcwb-tooltip-arrow'));

  document.body.appendChild(tooltip);
  activeTooltip = tooltip;

  // Position tooltip above the word
  positionTooltip(tooltip, wordEl);

  debugLog('WORD-TOOLTIP', `Showing tooltip for: ${word}`);
}

/**
 * Position tooltip above the target element
 * @param {HTMLElement} tooltip - Tooltip element
 * @param {HTMLElement} target - Target word element
 */
function positionTooltip(tooltip, target) {
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();

  // Calculate position
  let left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
  let top = targetRect.top - tooltipRect.height - 8;

  // Keep within viewport horizontally
  const padding = 10;
  if (left < padding) {
    left = padding;
  } else if (left + tooltipRect.width > window.innerWidth - padding) {
    left = window.innerWidth - tooltipRect.width - padding;
  }

  // If tooltip would go above viewport, show below
  if (top < padding) {
    top = targetRect.bottom + 8;
    tooltip.classList.add('gcwb-tooltip-below');
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

/**
 * Hide the active tooltip
 */
function hideTooltip() {
  hideTimeout = setTimeout(() => {
    cancelClauseDwell();
    tooltipGeneration++;
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
      debugLog('WORD-TOOLTIP', 'Tooltip hidden');
    }
  }, HIDE_DELAY_MS);
}

export function isTooltipTarget(target) {
  return !!target?.classList && (
    target.classList.contains('gcwb-cached-word') ||
    target.classList.contains('gcwb-auto-word') ||
    target.classList.contains('gcwb-auto-boundary') ||
    // A coloured native reading looks interactive, so it answers a hover with
    // its base word's data rather than nothing.
    target.classList.contains('gcwb-ruby-reading')
  );
}

/**
 * Handle mouseover events on cached word spans
 * @param {MouseEvent} event
 */
function handleMouseOver(event) {
  if (isTooltipTarget(event.target)) {
    showTooltip(event.target);
  }
}

/**
 * Handle mouseout events
 * @param {MouseEvent} event
 */
function handleMouseOut(event) {
  if (isTooltipTarget(event.target)) {
    // Check if moving to the tooltip itself
    const relatedTarget = event.relatedTarget;
    if (relatedTarget && activeTooltip?.contains(relatedTarget)) {
      return;
    }
    hideTooltip();
  }
}

/**
 * Handle tooltip hover (keep visible while hovering tooltip)
 * @param {MouseEvent} event
 */
function handleTooltipHover(event) {
  if (event.type === 'mouseenter' && activeTooltip) {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  } else if (event.type === 'mouseleave' && activeTooltip) {
    hideTooltip();
  }
}

/**
 * Set up event delegation for word tooltips. Idempotent: only the first call
 * binds, so multiple surfaces (chat/gmail/redmine/universal) can call it without
 * double-binding the document listeners (which would show duplicate tooltips).
 *
 * The clause translator is recorded before that guard, so a surface that binds
 * second can still supply one.
 * @param {{translateClause?: (clause: string) => Promise<string>, warmClauseTranslator?: () => void}} [options]
 */
export function setupWordTooltip(options = {}) {
  if (options.translateClause && !clauseTranslator) {
    clauseTranslator = {
      translate: options.translateClause,
      warm: options.warmClauseTranslator || (() => {}),
    };
  }

  if (listenersBound) return;
  listenersBound = true;

  // Use event delegation on document
  document.addEventListener('mouseover', handleMouseOver, true);
  document.addEventListener('mouseout', handleMouseOut, true);

  // Listen for tooltip hover events (to keep visible)
  document.addEventListener('mouseenter', (e) => {
    if (e.target === activeTooltip || activeTooltip?.contains(e.target)) {
      handleTooltipHover({ type: 'mouseenter' });
    }
  }, true);

  document.addEventListener('mouseleave', (e) => {
    if (e.target === activeTooltip) {
      handleTooltipHover({ type: 'mouseleave' });
    }
  }, true);

  debugLog('WORD-TOOLTIP', 'Tooltip event listeners set up');
}

/**
 * Force hide tooltip (e.g., when switching to full breakdown)
 */
export function forceHideTooltip() {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
  cancelClauseDwell();
  tooltipGeneration++;
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
}
