import { debugLog } from '../core/debug.js';
import { buildBreakdownPanelElement } from './panel-mode.js';

// Single floating card reused across all captions. Created lazily on first hover.
let cardEl = null;
let hideTimer = null;
let currentContainer = null;

// Per-container listener refs so we can detach cleanly.
const containerListeners = new WeakMap();

const HIDE_DELAY_MS = 200;
const VIEWPORT_PADDING = 12;

function ensureCardEl() {
  if (cardEl) return cardEl;

  cardEl = document.createElement('div');
  cardEl.className = 'mm-hover-card';
  // Park far off-screen so the first frame after making visible doesn't flash
  // at (0,0) before positionCard runs.
  cardEl.style.left = '-9999px';
  cardEl.style.top = '-9999px';
  cardEl.addEventListener('mouseenter', () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  cardEl.addEventListener('mouseleave', () => {
    scheduleHide();
  });
  document.body.appendChild(cardEl);
  return cardEl;
}

function positionCard(container) {
  const card = cardEl;
  if (!card) return;

  const targetRect = container.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();

  let left = targetRect.left + (targetRect.width / 2) - (cardRect.width / 2);
  let top = targetRect.top - cardRect.height - 8;

  if (left < VIEWPORT_PADDING) {
    left = VIEWPORT_PADDING;
  } else if (left + cardRect.width > window.innerWidth - VIEWPORT_PADDING) {
    left = window.innerWidth - cardRect.width - VIEWPORT_PADDING;
  }

  // If the card would spill above the viewport, flip below the caption.
  if (top < VIEWPORT_PADDING) {
    top = targetRect.bottom + 8;
  }

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideHoverCard();
  }, HIDE_DELAY_MS);
}

export function showHoverCard(container, breakdownData) {
  if (!breakdownData || !breakdownData.words) return;

  const card = ensureCardEl();

  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  // Repopulate only when the container changes, so that re-hovering the same
  // caption doesn't rebuild the DOM every time.
  if (currentContainer !== container) {
    card.innerHTML = '';
    card.appendChild(buildBreakdownPanelElement(breakdownData, true));
    currentContainer = container;
  }

  card.classList.add('mm-visible');
  // Position after making visible so width/height are measurable.
  positionCard(container);
  debugLog('MM-HOVER', `Show card for ${breakdownData.words.length} words`);
}

export function hideHoverCard() {
  if (!cardEl) return;
  cardEl.classList.remove('mm-visible');
  currentContainer = null;
  debugLog('MM-HOVER', 'Hide card');
}

/**
 * Attach mouseenter/leave listeners so this container shows the hover card.
 * Idempotent: repeated calls with the same container update the breakdown
 * data without adding duplicate listeners.
 */
export function attachHoverListeners(container, breakdownData) {
  const prev = containerListeners.get(container);
  if (prev) {
    prev.breakdownData = breakdownData;
    // If the card is currently visible for this container, refresh its content.
    if (currentContainer === container && cardEl) {
      currentContainer = null; // force repopulate on next show
      showHoverCard(container, breakdownData);
    }
    return;
  }

  const entry = { breakdownData, onEnter: null, onLeave: null };
  entry.onEnter = () => showHoverCard(container, entry.breakdownData);
  entry.onLeave = () => scheduleHide();

  container.addEventListener('mouseenter', entry.onEnter);
  container.addEventListener('mouseleave', entry.onLeave);

  containerListeners.set(container, entry);
}

export function detachHoverListeners(container) {
  const entry = containerListeners.get(container);
  if (!entry) return;
  container.removeEventListener('mouseenter', entry.onEnter);
  container.removeEventListener('mouseleave', entry.onLeave);
  containerListeners.delete(container);
  if (currentContainer === container) {
    hideHoverCard();
  }
}
