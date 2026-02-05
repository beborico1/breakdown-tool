import {
  activeGcwbContextMenu,
  setActiveGcwbContextMenu
} from '../core/state.js';
import { extractChatMessageText } from './message-finder.js';
import { showInlineBreakdown } from './inline-breakdown.js';

/**
 * Show custom context menu at cursor position
 * @param {MouseEvent} event - Right-click event
 * @param {HTMLElement} messageEl - Message element
 */
export function showCustomContextMenu(event, messageEl) {
  // Hide any existing menu
  hideCustomContextMenu();

  const text = extractChatMessageText(messageEl);
  if (!text) return;

  // Create context menu
  const menu = document.createElement('div');
  menu.className = 'gcwb-context-menu';
  menu.innerHTML = `
    <div class="gcwb-context-menu-item" data-action="analyze">
      <span class="gcwb-menu-icon">📖</span>
      <span class="gcwb-menu-text">Analyze Japanese</span>
    </div>
  `;

  // Position at cursor
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  // Handle click on menu item
  menu.querySelector('[data-action="analyze"]').addEventListener('click', (e) => {
    e.stopPropagation();  // Prevent click from bubbling to outside-click handlers
    hideCustomContextMenu();
    showInlineBreakdown(messageEl, text);
  });

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
