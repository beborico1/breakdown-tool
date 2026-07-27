import { collectBlockTextNodes, paintBlockTokens } from '../shared/auto-lite-core.js';
import { buildTogglePanel } from '../core/auto-translate-panel.js';

const GMAIL_EXCLUDE_TAGS = new Set(['PRE', 'CODE', 'IMG', 'OBJECT', 'BLOCKQUOTE']);

/** Trailing quoted history, which repeats text already painted further up. */
const QUOTE_SELECTOR = '.gmail_quote, .gmail_extra, .adL';

/**
 * Mark the quoted history so the shared assembler skips it.
 *
 * `collectBlockTextNodes` already rejects any subtree flagged this way, so this
 * reuses that hook rather than teaching the assembler about selectors. The mark
 * is left in place: it is inert, and re-marking on every pass would be wasted
 * work on a long thread.
 * @param {HTMLElement} bodyEl
 */
function markQuotedHistory(bodyEl) {
  for (const quoted of bodyEl.querySelectorAll(QUOTE_SELECTOR)) {
    if (quoted.dataset.gcwbSkip == null) quoted.dataset.gcwbSkip = '';
  }
}

/**
 * Public helper used by auto-analyze.js to build the analyzer-input string with
 * the same exclusions and ordering the renderer will use.
 *
 * @param {HTMLElement} bodyEl
 * @returns {string}
 */
export function assembleGmailText(bodyEl) {
  markQuotedHistory(bodyEl);
  return collectBlockTextNodes(bodyEl, GMAIL_EXCLUDE_TAGS).assembled;
}

/**
 * Render the lite auto-analyze view for a Gmail message body: in-place per-word
 * coloring with hoverable clause dots, plus a collapsible translation panel.
 *
 * @param {HTMLElement} bodyEl - The Gmail message body element.
 * @param {string} analyzerText - The exact text passed to the analyzer.
 * @param {{words:Array,translation:string,original?:string}} breakdownData
 */
export function renderGmailAutoLite(bodyEl, analyzerText, breakdownData) {
  if (!bodyEl || !breakdownData?.words?.length) return;
  if (bodyEl.dataset.gcwbAutoLite === '1') return;
  if (bodyEl.querySelector('.gcwb-auto-word')) return;

  markQuotedHistory(bodyEl);

  const translation = (breakdownData.translation || '').trim();

  paintBlockTokens(bodyEl, analyzerText, breakdownData.words, {
    marker: 'gcwbAutoLite',
    excludeTags: GMAIL_EXCLUDE_TAGS,
    boundaryDots: true,
    marks: 'ja',
    // Seeds the dot only when the body turns out to be a single clause; with
    // more, each dot resolves its own clause on hover.
    translation,
  });

  if (!translation) return;

  if (bodyEl.querySelector(':scope > .gcwb-auto-translate-toggle')) return;
  bodyEl.classList.add('gcwb-auto-bubble');
  const { btn, panel } = buildTogglePanel(translation);
  bodyEl.appendChild(btn);
  bodyEl.appendChild(panel);
}
