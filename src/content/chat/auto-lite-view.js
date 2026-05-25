import { debugLog } from '../core/debug.js';
import { getWordTypeClass, hasJapanese } from '../utils/text.js';
import { buildTogglePanel } from '../core/auto-translate-panel.js';

const liteState = new WeakMap();
const THIN_SPACE = ' ';

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}

function isSafeMessageEl(messageEl) {
  // Only mutate messages that are plain text (no rich children like links/mentions).
  for (const child of messageEl.children) {
    const tag = child.tagName;
    if (tag !== 'SPAN' && tag !== 'BR') return false;
  }
  return true;
}

function renderWordsHtml(words) {
  let html = '';
  let prevWasJa = false;
  let prevType = null;
  let tone = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const surface = w.japanese ?? '';
    if (!surface) continue;

    // Preserve newlines if the offline tokenizer emitted them.
    if (surface === '\n' || surface === '\r\n') {
      html += '<br>';
      prevWasJa = false;
      continue;
    }

    const isJa = hasJapanese(surface);
    if (isJa) {
      if (prevWasJa) html += THIN_SPACE;
      const typeClass = getWordTypeClass(w.type);
      tone = (w.type && w.type === prevType) ? 1 - tone : 0;
      const toneClass = tone === 1 ? ' gcwb-tone-alt' : '';
      prevType = w.type;
      const reading = (w.reading || '').trim() || surface;
      const romaji = (w.romaji || '').trim() || '-';
      const english = (w.english || '').trim() || '-';
      html += `<span class="gcwb-auto-word gcwb-type-${typeClass}${toneClass}" data-word="${escapeHtml(surface)}" data-reading="${escapeHtml(reading)}" data-romaji="${escapeHtml(romaji)}" data-english="${escapeHtml(english)}" data-type="${escapeHtml(typeClass)}">${escapeHtml(surface)}</span>`;
      prevWasJa = true;
    } else {
      html += escapeHtml(surface);
      prevWasJa = false;
    }
  }
  return html;
}

/**
 * Render the lite auto-analyze view: original-looking text with thin spaces between
 * Japanese tokens, plus a top-right chevron that expands a purple translation panel.
 *
 * @param {HTMLElement} messageEl - The .Zc1Emd text container
 * @param {{words:Array,translation:string}} breakdownData
 * @param {HTMLElement} bubbleEl - The .nF6pT bubble container
 */
export function renderAutoLiteView(messageEl, breakdownData, bubbleEl) {
  if (!messageEl || !breakdownData?.words?.length) return;
  if (liteState.has(messageEl)) return;
  if (bubbleEl?.querySelector('.gcwb-auto-translate-toggle')) return;
  if (!isSafeMessageEl(messageEl)) {
    debugLog('AUTO-LITE', 'Skipping: message has non-text children');
    return;
  }

  const originalHTML = messageEl.innerHTML;
  const wordsHtml = renderWordsHtml(breakdownData.words);
  if (!wordsHtml) return;

  liteState.set(messageEl, { originalHTML });
  messageEl.innerHTML = wordsHtml;
  messageEl.classList.add('gcwb-auto-lite');

  const translation = (breakdownData.translation || '').trim();
  if (!translation || !bubbleEl) return;

  bubbleEl.classList.add('gcwb-auto-bubble');
  const { btn, panel } = buildTogglePanel(translation);
  bubbleEl.appendChild(btn);
  // Append panel after the text container if possible, else at bubble end.
  if (messageEl.parentElement === bubbleEl && messageEl.nextSibling) {
    bubbleEl.insertBefore(panel, messageEl.nextSibling);
  } else {
    bubbleEl.appendChild(panel);
  }
}

export function getAutoLiteOriginalHTML(messageEl) {
  return liteState.get(messageEl)?.originalHTML || null;
}
