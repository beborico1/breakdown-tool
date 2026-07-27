import { collectBlockTextNodes, paintBlockTokens } from '../shared/auto-lite-core.js';
import { buildTogglePanel } from '../core/auto-translate-panel.js';

const REDMINE_EXCLUDE_TAGS = new Set(['PRE', 'CODE', 'IMG', 'OBJECT']);

const CONTAINER_SELECTOR = '.subject, .description, .journal, .wiki-page, .news, #activity dd';

/**
 * Public helper used by auto-analyze.js to build the analyzer-input string with
 * the same exclusions and ordering the renderer will use.
 *
 * @param {HTMLElement} blockEl
 * @returns {string}
 */
export function assembleRedmineText(blockEl) {
  return collectBlockTextNodes(blockEl, REDMINE_EXCLUDE_TAGS).assembled;
}

function findContainer(blockEl) {
  return blockEl.closest(CONTAINER_SELECTOR) || blockEl;
}

/**
 * Render the lite auto-analyze view for a Redmine block: in-place per-word
 * coloring + thin spaces (via the shared auto-lite core) + a collapsible purple
 * translation panel on a sensible container.
 *
 * @param {HTMLElement} blockEl - The Redmine text block element.
 * @param {string} analyzerText - The exact text passed to the analyzer.
 * @param {{words:Array,translation:string,original?:string}} breakdownData
 */
export function renderRedmineAutoLite(blockEl, analyzerText, breakdownData) {
  if (!blockEl || !breakdownData?.words?.length) return;
  if (blockEl.dataset.gcwbAutoLite === '1') return;
  if (blockEl.querySelector('.gcwb-auto-word')) return;

  const translation = (breakdownData.translation || '').trim();

  paintBlockTokens(blockEl, analyzerText, breakdownData.words, {
    marker: 'gcwbAutoLite',
    excludeTags: REDMINE_EXCLUDE_TAGS,
    boundaryDots: true,
    marks: 'ja',
    // Seeds the dot only when the block turns out to be a single clause; with
    // more, each dot resolves its own clause on hover.
    translation,
  });

  if (!translation) return;

  const containerEl = findContainer(blockEl);
  if (containerEl.querySelector(':scope > .gcwb-auto-translate-toggle')) return;
  containerEl.classList.add('gcwb-auto-bubble');
  const { btn, panel } = buildTogglePanel(translation);
  containerEl.appendChild(btn);
  containerEl.appendChild(panel);
}
