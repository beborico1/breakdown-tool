import { debugLog } from '../core/debug.js';
import { getWordTypeClass } from '../utils/text.js';

/**
 * Word Tooltip Module
 * Shows meaning on hover over cached/highlighted words
 */

// Active tooltip element
let activeTooltip = null;
let hideTimeout = null;
const HIDE_DELAY_MS = 100;

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

  // Get word data from element attributes
  const word = wordEl.dataset.word;
  const reading = wordEl.dataset.reading;
  const romaji = wordEl.dataset.romaji;
  const english = wordEl.dataset.english;
  const type = wordEl.dataset.type;

  if (!word) return;

  // Create tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'gcwb-word-tooltip';

  const typeClass = getWordTypeClass(type);
  const readingDisplay = reading && reading !== word ? reading : '';

  tooltip.innerHTML = `
    <div class="gcwb-tooltip-content">
      <div class="gcwb-tooltip-japanese gcwb-type-${typeClass}">${escapeHtml(word)}</div>
      ${readingDisplay ? `<div class="gcwb-tooltip-reading">${escapeHtml(readingDisplay)}</div>` : ''}
      ${romaji ? `<div class="gcwb-tooltip-romaji">${escapeHtml(romaji)}</div>` : ''}
      ${english ? `<div class="gcwb-tooltip-meaning">${escapeHtml(english)}</div>` : ''}
      ${type ? `<div class="gcwb-tooltip-type">${escapeHtml(type)}</div>` : ''}
    </div>
    <div class="gcwb-tooltip-arrow"></div>
  `;

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

/**
 * Escape HTML to prevent XSS
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Handle mouseover events on cached word spans
 * @param {MouseEvent} event
 */
function handleMouseOver(event) {
  const target = event.target;
  if (target.classList?.contains('gcwb-cached-word')) {
    showTooltip(target);
  }
}

/**
 * Handle mouseout events
 * @param {MouseEvent} event
 */
function handleMouseOut(event) {
  const target = event.target;
  if (target.classList?.contains('gcwb-cached-word')) {
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
 * Set up event delegation for word tooltips
 */
export function setupWordTooltip() {
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
