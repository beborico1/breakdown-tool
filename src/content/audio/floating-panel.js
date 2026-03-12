/**
 * Floating Panel for Audio Mode
 * Displays real-time Japanese word breakdowns from audio transcription.
 */

import { getWordTypeClass } from '../utils/text.js';

let panel = null;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

/**
 * Create and show the floating panel
 */
export function createPanel() {
  if (panel) return panel;

  panel = document.createElement('div');
  panel.className = 'audio-panel';
  panel.innerHTML = `
    <div class="audio-panel-header" id="audioPanelHeader">
      <div class="audio-panel-title">
        <span class="audio-panel-status"></span>
        Audio Mode
      </div>
      <button class="audio-panel-stop" id="audioPanelStop" title="Stop listening">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <rect x="4" y="4" width="16" height="16" rx="2"/>
        </svg>
      </button>
    </div>
    <div class="audio-panel-body" id="audioPanelBody"></div>
  `;

  document.body.appendChild(panel);

  // Apply saved font size
  loadFontSize();

  // Setup drag
  const header = panel.querySelector('#audioPanelHeader');
  header.addEventListener('mousedown', onDragStart);

  // Setup stop button
  const stopBtn = panel.querySelector('#audioPanelStop');
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stop-audio-capture' });
  });

  // Listen for font size changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.wordBlockFontSize) {
      applyFontSize(changes.wordBlockFontSize.newValue);
    }
  });

  return panel;
}

/**
 * Load and apply font size from storage
 */
function loadFontSize() {
  chrome.storage.sync.get(['wordBlockFontSize'], (result) => {
    applyFontSize(result.wordBlockFontSize || 15);
  });
}

/**
 * Apply font size CSS variables to panel
 */
function applyFontSize(baseSize) {
  if (!panel) return;
  const body = panel.querySelector('.audio-panel-body');
  if (!body) return;

  const scale = baseSize / 15;
  body.style.setProperty('--wb-font-japanese', `${baseSize}px`);
  body.style.setProperty('--wb-font-hiragana', `${Math.round(12 * scale)}px`);
  body.style.setProperty('--wb-font-romaji', `${Math.round(11 * scale)}px`);
  body.style.setProperty('--wb-font-english', `${Math.round(11 * scale)}px`);
  body.style.setProperty('--wb-font-translation', `${Math.round(14 * scale)}px`);
}

/**
 * Add a breakdown segment to the panel
 */
export function addSegment(breakdownData) {
  if (!panel) createPanel();

  const body = panel.querySelector('#audioPanelBody');

  // Remove processing indicator if present
  const processing = body.querySelector('.audio-segment-processing');
  if (processing) processing.remove();

  const segment = document.createElement('div');
  segment.className = 'audio-segment';

  // Word cards
  const wordsHtml = breakdownData.words.map((word, i) => {
    const typeClass = getWordTypeClass(word.type);
    const reading = (word.reading || '').trim();
    const romaji = (word.romaji || '').trim() || '-';
    const english = (word.english || '').trim() || '-';

    return `
      <div class="word-block" style="animation-delay: ${i * 0.03}s">
        <span class="word-japanese type-${typeClass}" data-type="${typeClass}">${escapeHtml(word.japanese)}</span>
        ${reading ? `<span class="word-hiragana">${escapeHtml(reading)}</span>` : ''}
        <span class="word-romaji">${escapeHtml(romaji)}</span>
        <span class="word-english">${escapeHtml(english)}</span>
      </div>
    `;
  }).join('');

  const translationDelay = (breakdownData.words.length * 0.03) + 0.1;

  segment.innerHTML = `
    <div class="audio-segment-words">${wordsHtml}</div>
    ${breakdownData.translation ? `
      <div class="breakdown-translation" style="animation-delay: ${translationDelay}s">
        "${escapeHtml(breakdownData.translation)}"
      </div>
    ` : ''}
  `;

  body.appendChild(segment);

  // Auto-scroll to newest
  body.scrollTop = body.scrollHeight;
}

/**
 * Show processing indicator
 */
export function showProcessing() {
  if (!panel) createPanel();

  const body = panel.querySelector('#audioPanelBody');

  // Don't add if one already exists
  if (body.querySelector('.audio-segment-processing')) return;

  const indicator = document.createElement('div');
  indicator.className = 'audio-segment-processing';
  indicator.innerHTML = `
    <div class="audio-processing-dots">
      <span class="audio-dot"></span>
      <span class="audio-dot"></span>
      <span class="audio-dot"></span>
    </div>
  `;

  body.appendChild(indicator);
  body.scrollTop = body.scrollHeight;
}

/**
 * Remove the floating panel
 */
export function removePanel() {
  if (panel) {
    panel.remove();
    panel = null;
  }
}

/**
 * Check if panel exists
 */
export function hasPanel() {
  return panel !== null;
}

// Drag handlers
function onDragStart(e) {
  if (e.target.closest('.audio-panel-stop')) return;

  isDragging = true;
  const rect = panel.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;

  panel.classList.add('audio-panel-dragging');
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  e.preventDefault();
}

function onDragMove(e) {
  if (!isDragging) return;

  const x = e.clientX - dragOffsetX;
  const y = e.clientY - dragOffsetY;

  // Remove bottom/right positioning, use top/left
  panel.style.bottom = 'auto';
  panel.style.right = 'auto';
  panel.style.left = `${Math.max(0, Math.min(x, window.innerWidth - 100))}px`;
  panel.style.top = `${Math.max(0, Math.min(y, window.innerHeight - 50))}px`;
}

function onDragEnd() {
  isDragging = false;
  panel.classList.remove('audio-panel-dragging');
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
