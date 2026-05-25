import {
  activeGcwbContextMenu,
  setActiveGcwbContextMenu
} from '../core/state.js';
import { showInlineBreakdown } from './inline-breakdown.js';
import { isPageLightMode } from '../utils/dom.js';
import { handleAddToAnki } from './anki-quick-add.js';

const COLOURED_WORD_SELECTOR = '.gcwb-auto-word, .mm-word, .gcwb-cached-word';

/**
 * Show custom context menu at cursor position
 * @param {MouseEvent} event - Right-click event
 * @param {HTMLElement} messageEl - Message element
 * @param {string} text - Extracted text to analyze
 * @param {Object} [options] - Optional extra menu items
 * @param {Function} [options.analyzeThread] - Callback for "Analyze Thread" action
 */
export function showCustomContextMenu(event, messageEl, text, options = {}) {
  // Hide any existing menu
  hideCustomContextMenu();

  if (!text) return;

  // If the right-click landed on a coloured/analyzed word, swap the primary
  // action to "Add to Anki" for that word (pokéball animation flow).
  const wordSpan = event.target?.closest?.(COLOURED_WORD_SELECTOR);
  const ankiWord = wordSpan && wordSpan.dataset?.word ? wordSpan : null;

  // Create context menu
  const menu = document.createElement('div');
  menu.className = 'gcwb-context-menu';
  if (isPageLightMode(messageEl)) menu.classList.add('gcwb-light');

  // Build menu items
  let menuHTML = ankiWord
    ? `
    <div class="gcwb-context-menu-item" data-action="add-anki">
      <span class="gcwb-menu-icon">＋</span>
      <span class="gcwb-menu-text">Add to Anki</span>
    </div>
  `
    : `
    <div class="gcwb-context-menu-item" data-action="analyze">
      <span class="gcwb-menu-icon">📖</span>
      <span class="gcwb-menu-text">Analyze Japanese</span>
    </div>
  `;

  if (options.analyzeThread) {
    menuHTML += `
    <div class="gcwb-context-menu-divider"></div>
    <div class="gcwb-context-menu-item" data-action="analyze-thread">
      <span class="gcwb-menu-icon">📚</span>
      <span class="gcwb-menu-text">Analyze Thread</span>
    </div>
    `;
  }

  menu.innerHTML = menuHTML;

  // Position at cursor
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  if (ankiWord) {
    menu.querySelector('[data-action="add-anki"]').addEventListener('click', (e) => {
      e.stopPropagation();
      hideCustomContextMenu();
      handleAddToAnki(ankiWord, {
        word: ankiWord.dataset.word || '',
        reading: ankiWord.dataset.reading || '',
        english: ankiWord.dataset.english || '',
        pos: ankiWord.dataset.type || '',
      });
    });
  } else {
    menu.querySelector('[data-action="analyze"]').addEventListener('click', (e) => {
      e.stopPropagation();
      hideCustomContextMenu();
      showInlineBreakdown(messageEl, text);
    });
  }

  // Handle click on "Analyze Thread" if present
  const threadItem = menu.querySelector('[data-action="analyze-thread"]');
  if (threadItem && options.analyzeThread) {
    threadItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideCustomContextMenu();
      options.analyzeThread();
    });
  }

  document.body.appendChild(menu);
  setActiveGcwbContextMenu(menu);

  // Close on click outside or ESC
  setTimeout(() => {
    document.addEventListener('click', handleContextMenuOutsideClick);
    document.addEventListener('keydown', handleContextMenuEscape);
  }, 0);
}

/**
 * Hide the custom context menu
 */
export function hideCustomContextMenu() {
  if (activeGcwbContextMenu) {
    activeGcwbContextMenu.remove();
    setActiveGcwbContextMenu(null);
    document.removeEventListener('click', handleContextMenuOutsideClick);
    document.removeEventListener('keydown', handleContextMenuEscape);
  }
}

function handleContextMenuOutsideClick(event) {
  if (activeGcwbContextMenu && !activeGcwbContextMenu.contains(event.target)) {
    hideCustomContextMenu();
  }
}

function handleContextMenuEscape(event) {
  if (event.key === 'Escape') {
    hideCustomContextMenu();
  }
}
