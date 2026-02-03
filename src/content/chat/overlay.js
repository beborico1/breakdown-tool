import { debugLog } from '../core/debug.js';
import {
  activeGcwbOverlay,
  setActiveGcwbOverlay,
  overlayCreatedAt,
  setOverlayCreatedAt,
  translationCache,
  activeContentKeys
} from '../core/state.js';
import { getWordTypeClass } from '../utils/text.js';
import { findCachedTranslation, generateContentKey, getTimeBucket } from '../core/cache.js';
import { analyzeJapaneseWithGemini } from '../core/api.js';

/**
 * Show overlay with cached data (no loading state needed)
 * @param {HTMLElement} anchorEl - Element to position overlay near
 * @param {Object} breakdownData - Cached breakdown data
 */
function showCachedOverlay(anchorEl, breakdownData) {
  const overlay = document.createElement('div');
  overlay.className = 'gcwb-overlay gcwb-overlay-enter';
  overlay.innerHTML = `
    <div class="gcwb-overlay-header">
      <button class="gcwb-overlay-close" data-action="close">&times;</button>
    </div>
    <div class="gcwb-overlay-content"></div>
  `;

  document.body.appendChild(overlay);
  setActiveGcwbOverlay(overlay);
  setOverlayCreatedAt(Date.now());

  positionOverlay(overlay, anchorEl);
  renderOverlayContent(overlay, breakdownData);

  // Set up close handlers
  overlay.querySelector('[data-action="close"]').addEventListener('click', hideBreakdownOverlay);
  document.addEventListener('keydown', handleOverlayEscape);
  setTimeout(() => {
    document.addEventListener('click', handleOverlayOutsideClick);
  }, 10);
}

/**
 * Show the word breakdown overlay
 * @param {HTMLElement} anchorEl - Element to position overlay near
 * @param {string} text - Text to analyze
 */
export async function showBreakdownOverlay(anchorEl, text) {
  // Hide any existing overlay
  hideBreakdownOverlay();

  // Check cache first - reuse previous analysis if available
  const cached = findCachedTranslation('GCWB', text);
  if (cached?.breakdownData) {
    debugLog('GCWB', 'Using cached breakdown');
    showCachedOverlay(anchorEl, cached.breakdownData);
    return;
  }

  // Create overlay with loading state (no cache hit)
  const overlay = document.createElement('div');
  overlay.className = 'gcwb-overlay gcwb-overlay-enter';

  // Initial loading state
  overlay.innerHTML = `
    <div class="gcwb-overlay-header">
      <button class="gcwb-overlay-close" data-action="close">&times;</button>
    </div>
    <div class="gcwb-overlay-content">
      <div class="gcwb-overlay-loading">Analyzing Japanese...</div>
    </div>
  `;

  document.body.appendChild(overlay);
  setActiveGcwbOverlay(overlay);
  setOverlayCreatedAt(Date.now());

  // Position overlay near the message
  positionOverlay(overlay, anchorEl);

  // Set up close handlers
  overlay.querySelector('[data-action="close"]').addEventListener('click', hideBreakdownOverlay);
  document.addEventListener('keydown', handleOverlayEscape);
  // Defer adding outside-click listener to prevent the click that opened the overlay from closing it
  setTimeout(() => {
    document.addEventListener('click', handleOverlayOutsideClick);
  }, 10);

  // Analyze the text
  try {
    const breakdownData = await analyzeJapaneseWithGemini(text);

    // Check if overlay was closed during analysis
    if (!activeGcwbOverlay) return;

    // Cache the result for future use
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
      debugLog('GCWB', `Cached breakdown: ${contentKey.slice(0, 40)}`);
    }

    renderOverlayContent(overlay, breakdownData);
  } catch (error) {
    if (!activeGcwbOverlay) return;

    overlay.querySelector('.gcwb-overlay-content').innerHTML = `
      <div class="gcwb-overlay-error">
        <div class="gcwb-error-message">Error: ${error.message}</div>
        <button class="gcwb-retry-btn" data-action="retry">Retry</button>
      </div>
    `;

    overlay.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
      showBreakdownOverlay(anchorEl, text);
    });
  }
}

/**
 * Render breakdown content in the overlay
 * @param {HTMLElement} overlay - Overlay element
 * @param {Object} breakdownData - Breakdown data from API
 */
function renderOverlayContent(overlay, breakdownData) {
  const wordsHtml = breakdownData.words.map(word => {
    const typeClass = getWordTypeClass(word.type);
    return `
      <div class="gcwb-word-card" data-word="${word.japanese}">
        <div class="gcwb-word-japanese gcwb-type-${typeClass}">${word.japanese}</div>
        ${word.reading ? `<div class="gcwb-word-hiragana">${word.reading}</div>` : ''}
        <div class="gcwb-word-romaji">${word.romaji}</div>
        <div class="gcwb-word-english">${word.english}</div>
      </div>
    `;
  }).join('');

  overlay.querySelector('.gcwb-overlay-content').innerHTML = `
    <div class="gcwb-overlay-words">${wordsHtml}</div>
    <div class="gcwb-overlay-translation">"${breakdownData.translation}"</div>
    <div class="gcwb-overlay-actions">
      <button class="gcwb-copy-btn" data-copy="japanese">Copy Japanese</button>
      <button class="gcwb-copy-btn" data-copy="romaji">Copy Romaji</button>
      <button class="gcwb-copy-btn" data-copy="english">Copy English</button>
    </div>
  `;

  // Store breakdown data for copy actions
  overlay.dataset.breakdownData = JSON.stringify(breakdownData);

  // Set up copy handlers
  overlay.querySelectorAll('.gcwb-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const copyType = e.target.dataset.copy;
      handleOverlayCopyAction(copyType, breakdownData, e.target);
    });
  });

  // Set up word card click to copy
  overlay.querySelectorAll('.gcwb-word-card').forEach(card => {
    card.addEventListener('click', () => {
      const word = card.dataset.word;
      navigator.clipboard.writeText(word).then(() => {
        card.classList.add('gcwb-copied');
        setTimeout(() => card.classList.remove('gcwb-copied'), 1500);
      });
    });
  });

  // Animate cards entrance
  const cards = overlay.querySelectorAll('.gcwb-word-card');
  cards.forEach((card, i) => {
    card.style.animationDelay = `${i * 0.03}s`;
  });
}

/**
 * Position overlay relative to anchor element
 * @param {HTMLElement} overlay - Overlay element
 * @param {HTMLElement} anchorEl - Anchor element
 */
function positionOverlay(overlay, anchorEl) {
  const anchorRect = anchorEl.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  // Try to position below the message
  let top = anchorRect.bottom + 8;
  let left = anchorRect.left;

  // If not enough space below, position above
  if (top + overlayRect.height > viewportHeight - 20) {
    top = anchorRect.top - overlayRect.height - 8;
  }

  // Keep within horizontal bounds
  if (left + overlayRect.width > viewportWidth - 20) {
    left = viewportWidth - overlayRect.width - 20;
  }
  if (left < 20) {
    left = 20;
  }

  // Ensure not above viewport
  if (top < 20) {
    top = 20;
  }

  overlay.style.left = `${left}px`;
  overlay.style.top = `${top}px`;
}

/**
 * Hide the breakdown overlay with animation
 */
export function hideBreakdownOverlay() {
  if (activeGcwbOverlay) {
    const overlay = activeGcwbOverlay;
    overlay.classList.remove('gcwb-overlay-enter');
    overlay.classList.add('gcwb-overlay-exit');

    setTimeout(() => {
      overlay.remove();
    }, 200);

    setActiveGcwbOverlay(null);
    document.removeEventListener('keydown', handleOverlayEscape);
    document.removeEventListener('click', handleOverlayOutsideClick);
  }
}

function handleOverlayEscape(event) {
  if (event.key === 'Escape') {
    hideBreakdownOverlay();
  }
}

function handleOverlayOutsideClick(event) {
  // Ignore clicks within 200ms of overlay creation to prevent immediate close
  if (Date.now() - overlayCreatedAt < 200) {
    return;
  }

  if (activeGcwbOverlay && !activeGcwbOverlay.contains(event.target)) {
    hideBreakdownOverlay();
  }
}

/**
 * Handle copy action from overlay buttons
 * @param {string} type - Copy type (japanese, romaji, english)
 * @param {Object} breakdownData - Breakdown data
 * @param {HTMLElement} button - Button element for feedback
 */
function handleOverlayCopyAction(type, breakdownData, button) {
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
    debugLog('GCWB-COPY', `Copied ${type}: ${text.slice(0, 50)}`);
  }).catch(err => {
    debugLog('GCWB-COPY', 'Failed:', err.message);
  });
}
