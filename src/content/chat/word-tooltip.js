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
 * Create and show tooltip for a word element
 * @param {HTMLElement} wordEl - The highlighted word span
 */
function showTooltip(wordEl) {
  // Clear any pending hide
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  // Remove existing tooltip
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }

  // Sentence-boundary dot: show the whole-message translation only (mirrors the
  // Meet hover-dot popover). These spans carry data-english but no data-word.
  if (wordEl.classList?.contains('gcwb-auto-boundary')) {
    const english = wordEl.dataset.english;
    if (!english) return;
    const tooltip = el('div', 'gcwb-word-tooltip gcwb-boundary-tooltip');
    if (isPageLightMode(wordEl)) tooltip.classList.add('gcwb-light');
    const content = el('div', 'gcwb-tooltip-content');
    content.appendChild(el('div', 'gcwb-tooltip-meaning gcwb-boundary-meaning', english));
    tooltip.appendChild(content);
    tooltip.appendChild(el('div', 'gcwb-tooltip-arrow'));
    document.body.appendChild(tooltip);
    activeTooltip = tooltip;
    positionTooltip(tooltip, wordEl);
    debugLog('WORD-TOOLTIP', 'Showing boundary translation tooltip');
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
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
      debugLog('WORD-TOOLTIP', 'Tooltip hidden');
    }
  }, HIDE_DELAY_MS);
}

function isTooltipTarget(target) {
  return !!target?.classList && (
    target.classList.contains('gcwb-cached-word') ||
    target.classList.contains('gcwb-auto-word') ||
    target.classList.contains('gcwb-auto-boundary')
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
 */
export function setupWordTooltip() {
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
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
}
