import { debugLog } from '../core/debug.js';
import { forceHideTooltip } from './word-tooltip.js';
import { KAIGI_MODEL_NAME } from './anki-model.js';
import { enqueueAnkiAdd, flushAnkiQueue } from '../core/anki-queue.js';
import { addOneCard, isRetriableAnkiError } from '../core/anki-card.js';
import { loadAnkiAddedWords, markAnkiAdded } from '../core/anki-added.js';

let popoverEl = null;
let popoverWordEl = null;

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function closePopover() {
  if (popoverEl) {
    popoverEl.remove();
    popoverEl = null;
    popoverWordEl = null;
  }
  document.removeEventListener('mousedown', onDocMouseDown, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
  window.removeEventListener('scroll', closePopover, true);
  window.removeEventListener('resize', closePopover, true);
}

function onDocMouseDown(e) {
  if (popoverEl && !popoverEl.contains(e.target)) closePopover();
}

function onDocKeyDown(e) {
  if (e.key === 'Escape') closePopover();
}

function openPopover(wordSpan) {
  closePopover();
  forceHideTooltip?.();

  const word = wordSpan.dataset.word || '';
  const reading = wordSpan.dataset.reading || '';
  const english = wordSpan.dataset.english || '';
  const pos = wordSpan.dataset.type || '';

  const pop = document.createElement('div');
  pop.className = 'gcwb-anki-popover';
  pop.innerHTML = `
    <div class="gcwb-anki-popover-header">
      <span class="gcwb-anki-popover-word">${escapeHtml(word)}</span>
      ${reading && reading !== word ? `<span class="gcwb-anki-popover-reading">${escapeHtml(reading)}</span>` : ''}
    </div>
    <button class="gcwb-anki-popover-action" type="button">
      <span class="gcwb-anki-popover-icon">＋</span>
      <span>Add to Anki</span>
    </button>
  `;
  document.body.appendChild(pop);

  const rect = wordSpan.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  // Flip up if no room
  if (top + popRect.height > window.innerHeight - 8) {
    top = rect.top - popRect.height - 8;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;

  pop.querySelector('.gcwb-anki-popover-action').addEventListener('click', () => {
    const targetSpan = wordSpan;
    closePopover();
    handleAddToAnki(targetSpan, { word, reading, english, pos });
  });

  popoverEl = pop;
  popoverWordEl = wordSpan;

  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
  window.addEventListener('scroll', closePopover, true);
  window.addEventListener('resize', closePopover, true);
}

const WORD_SELECTOR = '.gcwb-auto-word, .mm-word';

export { onContextMenu as handleAnkiContextMenu };

function onContextMenu(event) {
  let span = null;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (node?.nodeType === 1 && node.matches?.(WORD_SELECTOR) && node.dataset?.word) {
      span = node;
      break;
    }
  }
  if (!span) {
    span = event.target?.closest?.(WORD_SELECTOR);
  }
  if (!span || !span.dataset?.word) {
    // Some surfaces (e.g. Google Meet's caption container) layer a transparent
    // wrapper over the colored text; the contextmenu target is that wrapper,
    // so the .mm-word never appears in the event path. Hit-test by point.
    const stack = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(event.clientX, event.clientY)
      : [];
    for (const el of stack) {
      if (el?.nodeType === 1 && el.matches?.(WORD_SELECTOR) && el.dataset?.word) {
        span = el;
        break;
      }
    }
    if (!span || !span.dataset?.word) return;
  }
  event.preventDefault();
  event.stopPropagation();
  debugLog('ANKI-CTX', `match word="${span.dataset.word}"`);
  openPopover(span);
}

const addToAnki = addOneCard;

function prefersReducedMotion() {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function showToast({ variant = 'success', word = '', deck = '', model = '', errorMessage = '', duration = 2200 }) {
  const existing = document.querySelector('.gcwb-anki-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `gcwb-anki-toast${variant === 'error' ? ' is-error' : ''}`;

  const accent = document.createElement('span');
  accent.className = 'gcwb-anki-toast-accent';

  const iconWrap = document.createElement('span');
  iconWrap.className = 'gcwb-anki-toast-icon';
  const ball = document.createElement('span');
  ball.className = 'gcwb-pokeball gcwb-pokeball-static';
  iconWrap.appendChild(ball);

  const body = document.createElement('div');
  body.className = 'gcwb-anki-toast-body';
  const title = document.createElement('div');
  title.className = 'gcwb-anki-toast-title';
  const sub = document.createElement('div');
  sub.className = 'gcwb-anki-toast-sub';

  if (variant === 'queued') {
    title.textContent = 'Queued for Anki';
    sub.textContent = errorMessage || 'Open Anki and the card will be added automatically. See AnkiConnect Setup on the Word Frequency page.';
  } else if (variant === 'error') {
    title.textContent = 'Could not add to Anki';
    sub.textContent = errorMessage || 'Anki not reachable — is Anki running?';
  } else {
    title.textContent = 'Added to Anki';
    sub.textContent = `${deck || 'kaigi'} · ${model || KAIGI_MODEL_NAME}`;
  }
  body.appendChild(title);
  body.appendChild(sub);

  toast.appendChild(accent);
  toast.appendChild(iconWrap);
  toast.appendChild(body);

  if (variant !== 'error' && variant !== 'queued' && word) {
    const chip = document.createElement('span');
    chip.className = 'gcwb-anki-toast-chip';
    chip.textContent = word;
    toast.appendChild(chip);
  }

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('is-leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, duration);
  return toast;
}

function playPokeballCapture(wordSpan) {
  return new Promise((resolve) => {
    if (!wordSpan?.isConnected || prefersReducedMotion()) {
      wordSpan?.classList.add('gcwb-anki-flash');
      setTimeout(() => wordSpan?.classList.remove('gcwb-anki-flash'), 400);
      resolve();
      return;
    }

    const rect = wordSpan.getBoundingClientRect();
    const ballSize = Math.max(28, Math.min(rect.height * 1.8, 44));
    const targetX = rect.left + rect.width / 2 - ballSize / 2;
    const targetY = rect.top + rect.height / 2 - ballSize / 2;

    const stage = document.createElement('div');
    stage.className = 'gcwb-pokeball-stage';
    stage.style.left = `${targetX}px`;
    stage.style.top = `${targetY}px`;
    stage.style.width = `${ballSize}px`;
    stage.style.height = `${ballSize}px`;

    const ball = document.createElement('div');
    ball.className = 'gcwb-pokeball';
    stage.appendChild(ball);
    document.body.appendChild(stage);

    // Phase A: throw (500ms) — handled by CSS animation on .gcwb-pokeball
    // Phase B: word suck (200ms after 500ms)
    setTimeout(() => {
      wordSpan.classList.add('gcwb-being-captured');
    }, 500);

    // Phase C: wiggle starts at 700ms (added via class)
    setTimeout(() => {
      ball.classList.add('is-wiggling');
    }, 700);

    // Phase D: spark burst at 1500ms
    setTimeout(() => {
      ball.classList.add('is-captured');
      const sparkCount = 8;
      for (let i = 0; i < sparkCount; i++) {
        const spark = document.createElement('div');
        spark.className = 'gcwb-spark';
        const angle = (i / sparkCount) * Math.PI * 2;
        spark.style.setProperty('--dx', `${Math.cos(angle) * 36}px`);
        spark.style.setProperty('--dy', `${Math.sin(angle) * 36}px`);
        stage.appendChild(spark);
      }
    }, 1500);

    // Phase E: cleanup at 2200ms
    setTimeout(() => {
      stage.classList.add('is-leaving');
    }, 1800);
    setTimeout(() => {
      stage.remove();
      wordSpan.classList.remove('gcwb-being-captured');
      resolve();
    }, 2200);
  });
}

export async function handleAddToAnki(wordSpan, wordData) {
  const animPromise = playPokeballCapture(wordSpan);
  let succeeded = false;
  let deck = '';
  let model = '';
  let errMsg = '';
  let retriable = false;
  try {
    const res = await addToAnki(wordData);
    succeeded = true;
    deck = res?.deck || '';
    model = res?.model || '';
  } catch (err) {
    errMsg = err?.message || String(err);
    retriable = isRetriableAnkiError(errMsg);
    debugLog('ANKI-QUICK', 'Add failed:', errMsg, 'retriable:', retriable);
  }
  await animPromise;
  if (succeeded) {
    wordSpan?.classList.add('gcwb-anki-added');
    markAnkiAdded(wordData.word);
    showToast({ variant: 'success', word: wordData.word, deck, model });
    // Opportunistically drain backlog after a successful add.
    flushPendingAdds().catch(() => {});
  } else if (retriable) {
    await enqueueAnkiAdd(wordData);
    wordSpan?.classList.add('gcwb-anki-added');
    markAnkiAdded(wordData.word);
    showToast({ variant: 'queued', duration: 6500 });
  } else {
    showToast({ variant: 'error', errorMessage: errMsg });
  }
}

export async function flushPendingAdds() {
  const { flushed } = await flushAnkiQueue(async (card) => {
    try {
      await addToAnki(card);
      return { ok: true, retriable: false };
    } catch (err) {
      const msg = err?.message || String(err);
      return { ok: false, retriable: isRetriableAnkiError(msg) };
    }
  });
  if (flushed > 0) {
    showToast({
      variant: 'success',
      word: '',
      deck: '',
      model: '',
    });
    // Override title for the consolidated flush toast.
    const t = document.querySelector('.gcwb-anki-toast .gcwb-anki-toast-title');
    const s = document.querySelector('.gcwb-anki-toast .gcwb-anki-toast-sub');
    if (t) t.textContent = `Added ${flushed} queued card${flushed === 1 ? '' : 's'} to Anki`;
    if (s) s.textContent = 'Backlog flushed';
  }
}

let contextMenuAttached = false;
export function attachAnkiContextMenu(target = window) {
  if (contextMenuAttached) return;
  contextMenuAttached = true;
  target.addEventListener('contextmenu', onContextMenu, true);
}

export function initAnkiQuickAdd() {
  debugLog('ANKI-QUICK', 'Anki quick-add ready (chat menu route)');
  loadAnkiAddedWords().catch(() => {});
  flushPendingAdds().catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      flushPendingAdds().catch(() => {});
    }
  });
}
