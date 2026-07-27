import { debugLog } from '../core/debug.js';

let activePopover = null;
let activeWordEl = null;
let hideTimer = null;

// Short safety net only — pointermove re-evaluates every frame, so we don't
// need the old 600ms cushion that used to mask layout shifts.
const HIDE_DELAY_MS = 150;
const VIEWPORT_PADDING = 8;

// Surfaces that can contain colorized words — the only places a hit-test can
// turn up anything.
const CAPTION_SURFACE_SELECTOR = '.nMcdL, .segment-card, [data-mm-words-root]';

let documentListenerInstalled = false;
const registeredContainers = new WeakSet();
let pendingFrame = false;
let lastPointerEvent = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(removePopover, HIDE_DELAY_MS);
}

function removePopover() {
  if (activePopover) { activePopover.remove(); activePopover = null; }
  activeWordEl = null;
  debugLog('MM-HOVER', 'Hide word popover');
}

function positionPopover(wordEl) {
  if (!activePopover) return;
  const wr = wordEl.getBoundingClientRect();
  const pr = activePopover.getBoundingClientRect();

  let left = wr.left + wr.width / 2 - pr.width / 2;
  let top  = wr.top  - pr.height - 8;

  if (left < VIEWPORT_PADDING) left = VIEWPORT_PADDING;
  if (left + pr.width > window.innerWidth - VIEWPORT_PADDING) {
    left = window.innerWidth - pr.width - VIEWPORT_PADDING;
  }

  const flipped = top < VIEWPORT_PADDING;
  if (flipped) top = wr.bottom + 8;
  activePopover.classList.toggle('gcwb-popover-below', flipped);

  if (top + pr.height > window.innerHeight - VIEWPORT_PADDING) {
    top = window.innerHeight - pr.height - VIEWPORT_PADDING;
  }
  if (top < VIEWPORT_PADDING) top = VIEWPORT_PADDING;

  activePopover.style.left = `${left}px`;
  activePopover.style.top  = `${top}px`;
}

function showWordPopover(wordEl) {
  const isBoundary = wordEl.classList.contains('mm-boundary');
  const english = wordEl.dataset.english;

  if (isBoundary && !english) return;
  if (!isBoundary && !wordEl.dataset.word) return;

  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

  // Same target in the same caption — reposition without recreating.
  const captionSelector = '.nMcdL, .segment-card, [data-mm-words-root]';
  const sameCaption = activeWordEl?.closest?.(captionSelector) === wordEl.closest?.(captionSelector);
  const sameTargetKey = isBoundary
    ? activeWordEl?.classList?.contains('mm-boundary') && activeWordEl?.dataset?.english === english
    : activeWordEl?.dataset?.word === wordEl.dataset.word;
  if (sameCaption && sameTargetKey) {
    activeWordEl = wordEl;
    positionPopover(wordEl);
    return;
  }

  if (activePopover) { activePopover.remove(); activePopover = null; }

  const popover = document.createElement('div');
  popover.className = 'gcwb-word-popover';

  if (isBoundary) {
    popover.innerHTML = `
      <div class="gcwb-popover-arrow"></div>
      <div class="gcwb-popover-content">
        <div class="gcwb-popover-meaning">${escapeHtml(english)}</div>
      </div>
    `;
  } else {
    const word      = wordEl.dataset.word;
    const reading   = wordEl.dataset.reading;
    const romaji    = wordEl.dataset.romaji;
    const typeClass = wordEl.dataset.type;
    popover.innerHTML = `
      <div class="gcwb-popover-arrow"></div>
      <div class="gcwb-popover-content">
        <div class="gcwb-popover-reading gcwb-type-${typeClass}">${escapeHtml(reading || word)}</div>
        ${romaji  ? `<div class="gcwb-popover-romaji">${escapeHtml(romaji)}</div>`   : ''}
        ${english ? `<div class="gcwb-popover-meaning">${escapeHtml(english)}</div>` : ''}
      </div>
    `;
  }
  popover.addEventListener('mouseenter', () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  });
  popover.addEventListener('mouseleave', scheduleHide);

  document.body.appendChild(popover);
  activePopover = popover;
  activeWordEl  = wordEl;

  positionPopover(wordEl);
  debugLog('MM-HOVER', isBoundary ? `Show boundary popover` : `Show word popover: ${wordEl.dataset.word}`);
}

function getWordElAtPoint(x, y) {
  // elementsFromPoint ignores pointer-events CSS, so it finds .mm-word spans
  // even when a Google Meet overlay sits on top of the caption text.
  const els = document.elementsFromPoint?.(x, y) ?? [document.elementFromPoint(x, y)];
  return els.find(el => el?.classList?.contains('mm-word') || el?.classList?.contains('mm-boundary')) ?? null;
}

function processPointer() {
  pendingFrame = false;
  const e = lastPointerEvent;
  if (!e) return;

  // Cheap check first: when the pointer really is over a word, the event target
  // is inside it and no hit-test is needed. elementsFromPoint forces a layout,
  // and this runs on every animation frame the mouse moves.
  let wordEl = (e.target && e.target.closest && e.target.closest('.mm-word, .mm-boundary')) || null;

  // The hit-test only rescues words sitting under an overlay or clipped at an
  // edge, which can only happen over a caption surface or under an open
  // popover. Anywhere else on the page there is nothing for it to find, so
  // ordinary mouse movement no longer pays for a layout every frame.
  if (!wordEl && (activePopover || e.target?.closest?.(CAPTION_SURFACE_SELECTOR))) {
    wordEl = getWordElAtPoint(e.clientX, e.clientY);
  }

  if (wordEl) {
    showWordPopover(wordEl);
    return;
  }

  if (!activePopover) return;

  const allEls = document.elementsFromPoint?.(e.clientX, e.clientY) ?? [e.target];
  if (allEls.some(el => el?.classList?.contains('gcwb-word-popover'))) return;

  if (activeWordEl) {
    const activeCaption = activeWordEl.closest(CAPTION_SURFACE_SELECTOR);
    if (activeCaption && allEls.some(el => activeCaption.contains(el))) return;
  }

  removePopover();
}

function installDocumentListeners() {
  if (documentListenerInstalled) return;
  documentListenerInstalled = true;

  // pointermove fires continuously, so every frame re-evaluates the word under
  // the cursor. This prevents stale popovers when mouseover skips an element.
  document.addEventListener('pointermove', (e) => {
    lastPointerEvent = e;
    if (pendingFrame) return;
    pendingFrame = true;
    requestAnimationFrame(processPointer);
  }, true /* capture — fires before Meet's own handlers */);

  document.addEventListener('pointerleave', () => {
    if (activePopover) scheduleHide();
  }, true);
}

export function attachHoverListeners(container, _breakdownData) {
  installDocumentListeners();
  registeredContainers.add(container);
}

export function detachHoverListeners(container) {
  registeredContainers.delete(container);
  if (activeWordEl && container.contains(activeWordEl)) removePopover();
}

export function hideHoverCard() { removePopover(); }
export function showHoverCard() {}
