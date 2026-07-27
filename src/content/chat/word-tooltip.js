import { count, markOnce } from '../../metrics/index.js';
import { M, F } from '../../metrics/events.js';
import { debugLog } from '../core/debug.js';
import { getWordTypeClass } from '../utils/text.js';
import { isPageLightMode } from '../utils/dom.js';
import { isIslandMember, getIslandPhrase, getIslandRect, islandSize } from '../shared/word-island.js';

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
 * @type {{translate: (clause: string) => Promise<string>, peek: (clause: string) => string, warm: () => void}|null}
 */
let clauseTranslator = null;

/** Pointer dwell before a hover is worth a translation request. */
const CLAUSE_HOVER_DWELL_MS = 150;

/**
 * Settle time before an island is worth translating.
 *
 * Every click changes the phrase, so every intermediate island is a distinct
 * cache key that neither the LRU nor the in-flight dedupe in clause-translate
 * can collapse, and they all serialize onto the one translator session the
 * boundary dots share. Translating on the hover dwell alone would spend a
 * request on every prefix of the phrase and queue the one they wanted last.
 *
 * This is a debounce, not a per-island budget: it is measured from the last
 * island change, so a run built at any pace quicker than this costs a single
 * request, and one built more slowly than this pays for the prefixes it pauses
 * on. Cancelling an issued request is not possible, so the slower case is
 * accepted rather than engineered around. It is bounded and self-limiting: each
 * one is a short on-device call, each result is cached, and the reader is by
 * definition not waiting on the box while they are still clicking.
 */
const ISLAND_SETTLE_MS = 450;

let clauseDwellTimer = null;

/** When the island last changed, so a dwell can tell settled from mid-build. */
let islandChangedAt = 0;

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

/**
 * Whether the reader has turned sentence translations off.
 *
 * An island's English is machine translation of a phrase, the same category as
 * a clause dot's, so it answers to `showTranslation` rather than to
 * `showMeaning`, which governs per-word dictionary glosses. Checked here rather
 * than left to CSS because a hidden row would still have cost a translation.
 */
function translationsHidden() {
  return !!document.documentElement?.classList?.contains('kaigi-hide-translation');
}

/**
 * Show the tooltip for a word that is part of an island.
 *
 * Renders the joined phrase at once and fills its English in when the request
 * resolves, the same shape as a boundary dot. Unlike a dot there is no element
 * to cache the result on, so a second hover reads it back out of the clause
 * translator's own cache instead.
 * @param {HTMLElement} anchorEl - the member under the pointer
 * @param {string} phrase - the joined text, already resolved by the caller
 */
function showIslandTooltip(anchorEl, phrase) {
  const tooltip = el('div', 'gcwb-word-tooltip gcwb-boundary-tooltip gcwb-island-tooltip');
  if (isPageLightMode(anchorEl)) tooltip.classList.add('gcwb-light');
  const content = el('div', 'gcwb-tooltip-content');
  content.appendChild(el('div', 'gcwb-tooltip-japanese', phrase));

  const hidden = translationsHidden();
  const cached = hidden ? '' : (clauseTranslator?.peek(phrase) || '');
  let meaning = null;
  if (!hidden) {
    meaning = el('div', 'gcwb-boundary-meaning', cached || '...');
    if (!cached) meaning.classList.add('gcwb-boundary-pending');
    content.appendChild(meaning);
  }
  tooltip.appendChild(content);
  tooltip.appendChild(el('div', 'gcwb-tooltip-arrow'));
  document.body.appendChild(tooltip);
  activeTooltip = tooltip;
  positionTooltip(tooltip, getIslandRect() || anchorEl);

  if (hidden || cached || !clauseTranslator) {
    debugLog('WORD-TOOLTIP', 'Showing island tooltip');
    return;
  }

  clauseTranslator.warm();
  const generation = tooltipGeneration;
  // Wait out the settle window measured from the last click, not from this
  // hover, so an island still being built spends no requests on its prefixes.
  const settledIn = Math.max(CLAUSE_HOVER_DWELL_MS, ISLAND_SETTLE_MS - (Date.now() - islandChangedAt));
  clauseDwellTimer = setTimeout(() => {
    clauseDwellTimer = null;
    clauseTranslator.translate(phrase).then((result) => {
      if (generation !== tooltipGeneration || !tooltip.isConnected) return;
      meaning.textContent = result || 'Translation unavailable';
      if (result) meaning.classList.remove('gcwb-boundary-pending');
      // The box just changed height, and the island may have scrolled since the
      // hover, so both ends of the measurement have to be read again.
      positionTooltip(tooltip, getIslandRect() || anchorEl);
    });
  }, settledIn);
}

function showBoundaryTooltip(dotEl) {
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

  // A joined run answers with the phrase rather than with whichever word the
  // pointer happens to be on. A one-word island is not asked about as a phrase,
  // so it keeps the ordinary word card.
  //
  // The phrase is resolved before branching because resolving it is also what
  // revalidates the island: if the site pulled a member out of the page, it
  // comes back empty and the island is dropped, and this word is owed the
  // ordinary card rather than nothing at all.
  const islandPhrase = isIslandMember(wordEl) && islandSize() > 1 ? getIslandPhrase() : '';
  if (islandPhrase) {
    showIslandTooltip(wordEl, islandPhrase);
    return;
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
 * Position tooltip above the target
 * @param {HTMLElement} tooltip - Tooltip element
 * @param {HTMLElement|DOMRect} target - Target element, or the box to sit above.
 *   An island spans several elements, so it hands over its own union box.
 */
function positionTooltip(tooltip, target) {
  const targetRect = typeof target.getBoundingClientRect === 'function'
    ? target.getBoundingClientRect()
    : target;
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
    // Counted here rather than inside showTooltip, which also runs when a click
    // changes the island. That is not a hover, and letting it through would
    // inflate the headline engagement counter with clicks.
    countHover();
    showTooltip(event.target);
  }
}

/**
 * Re-render for a changed island.
 *
 * Called with the word the change came from, which is still under the pointer,
 * so the box is rebuilt in place rather than left showing the previous phrase.
 * After the last word is unjoined the same anchor gets the ordinary word card,
 * which is what a pointer resting on a plain coloured word should show.
 * @param {HTMLElement|null} anchorEl
 */
export function onIslandChange(anchorEl) {
  islandChangedAt = Date.now();
  forceHideTooltip();
  if (anchorEl?.isConnected) showTooltip(anchorEl);
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
 * @param {{translateClause?: (clause: string) => Promise<string>, warmClauseTranslator?: () => void, peekClauseTranslation?: (clause: string) => string}} [options]
 */
export function setupWordTooltip(options = {}) {
  if (options.translateClause && !clauseTranslator) {
    clauseTranslator = {
      translate: options.translateClause,
      // An island has no element to cache its English on the way a dot does, so
      // a re-hover reads the translator's own cache to paint on the first frame
      // instead of flashing a pending placeholder.
      peek: options.peekClauseTranslation || (() => ''),
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
