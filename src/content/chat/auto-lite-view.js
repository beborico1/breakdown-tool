import { debugLog } from '../core/debug.js';
import { hasJapanese, segmentClauses, MIN_SYNTHETIC_CLAUSE_CHARS } from '../utils/text.js';
import { buildTogglePanel } from '../core/auto-translate-panel.js';
import { collectTextNodes, applyAutoWordsToTextNode } from '../utils/highlight.js';
import { findQuotedBlockContainer } from './message-finder.js';
import { getPreHighlightHTML } from './word-highlight.js';

const liteState = new WeakMap();

// Text nodes inside these elements belong to mention chips / links and must be left
// untouched so the styled username tags survive auto-analyze.
const CHIP_SELECTOR = 'a, [data-member-id], [data-display-name], .fWwrkf';

function isInsideChip(textNode) {
  const parent = textNode.parentElement;
  return !!(parent && parent.closest(CHIP_SELECTOR));
}

/**
 * Map the breakdown's Japanese tokens onto character offsets within `fullText`.
 * Search-based (indexOf from a moving cursor) so it tolerates whitespace differences
 * between the tokenizer output and the live DOM. Non-Japanese tokens advance the
 * cursor but are not wrapped.
 * @returns {Array<{word: string, start: number, end: number, data: Object}>}
 */
function buildGlobalMatches(words, fullText) {
  const matches = [];
  let cursor = 0;
  for (const w of words) {
    const surface = w.japanese ?? '';
    if (!surface || surface === '\n' || surface === '\r\n') continue;
    const idx = fullText.indexOf(surface, cursor);
    if (idx === -1) continue;
    const end = idx + surface.length;
    cursor = end;
    if (hasJapanese(surface)) {
      matches.push({ kind: 'word', word: surface, start: idx, end, data: w });
    }
  }
  return matches;
}

/**
 * Render the lite auto-analyze view in place: wraps Japanese tokens in interactive
 * `gcwb-auto-word` spans by mutating text nodes only, so mention chips, links, and
 * other rich children are preserved. Adds a top-right chevron that expands a purple
 * translation panel.
 *
 * @param {HTMLElement} messageEl - The .Zc1Emd text container
 * @param {{words:Array,translation:string}} breakdownData
 * @param {HTMLElement} bubbleEl - The .nF6pT bubble container
 */
export function renderAutoLiteView(messageEl, breakdownData, bubbleEl) {
  if (!messageEl || !breakdownData?.words?.length) return;
  if (liteState.has(messageEl)) return;
  if (bubbleEl?.querySelector('.gcwb-auto-translate-toggle')) return;

  // If the cached-word highlighter already fragmented this message (e.g. offline NLP
  // was toggled on after the highlighter ran), restore the clean pre-highlight HTML
  // first, so a token straddling a `.gcwb-cached-word` boundary isn't dropped by the
  // node-containment check below. On the common path the highlighter is gated off and
  // this is null (no-op).
  const preHighlight = getPreHighlightHTML(messageEl);
  if (preHighlight) messageEl.innerHTML = preHighlight;

  // Collect text nodes the same way the analyzed text was extracted, so token
  // surfaces line up with the live DOM (quoted blocks excluded, highlights included).
  const quoted = findQuotedBlockContainer(messageEl);
  const textNodes = collectTextNodes(messageEl, quoted, { includeHighlighted: true });
  if (textNodes.length === 0) return;

  const fullText = textNodes.map(n => n.nodeValue).join('');
  const globalMatches = buildGlobalMatches(breakdownData.words, fullText);
  if (globalMatches.length === 0) {
    debugLog('AUTO-LITE', 'Skipping: no Japanese tokens mapped to text');
    return;
  }

  const originalHTML = messageEl.innerHTML;
  const translation = (breakdownData.translation || '').trim();

  // Clause-ending dots become hoverable boundary spans. Each carries its own
  // clause and resolves that clause's English on hover, so a dot never reveals
  // a neighbouring clause. A message translation describes the whole message,
  // so it only seeds a dot when the message is a single clause. Dots never
  // overlap a wrapped word.
  const clauses = segmentClauses(fullText, { marks: 'ja' }).filter(c => c.hasJapanese);
  const seed = clauses.length === 1 ? translation : '';
  const boundaries = [];
  for (const c of clauses) {
    const isSynthetic = !c.terminated;
    if (isSynthetic && c.text.length < MIN_SYNTHETIC_CLAUSE_CHARS) continue;
    const start = isSynthetic ? c.contentEnd : c.markStart;
    const end = isSynthetic ? c.contentEnd : c.markEnd;
    if (globalMatches.some(w => start < w.end && w.start < end)) continue;
    boundaries.push({
      kind: 'boundary',
      word: isSynthetic ? '' : fullText.slice(start, end),
      start,
      end,
      data: { english: seed, clause: c.text, synthetic: isSynthetic },
    });
  }
  const allMatches = boundaries.length
    ? [...globalMatches, ...boundaries].sort((a, b) => (a.start - b.start) || (a.end - b.end))
    : globalMatches;

  // Distribute matches onto individual text nodes (skipping chip/link nodes),
  // then wrap in place. Iterate a snapshot since applying mutates the DOM live.
  let offset = 0;
  let appliedWords = 0;
  for (const textNode of textNodes) {
    const nodeStart = offset;
    const nodeEnd = offset + (textNode.nodeValue?.length || 0);
    offset = nodeEnd;
    if (isInsideChip(textNode)) continue;

    const local = [];
    for (const m of allMatches) {
      if (m.start >= nodeStart && m.end <= nodeEnd) {
        local.push({ ...m, start: m.start - nodeStart, end: m.end - nodeStart });
      }
    }
    if (local.length === 0) continue;
    applyAutoWordsToTextNode(textNode, local);
    appliedWords += local.filter(m => m.kind !== 'boundary').length;
  }

  if (appliedWords === 0) {
    debugLog('AUTO-LITE', 'Skipping: all tokens fell inside chips/links');
    messageEl.innerHTML = originalHTML; // undo any boundary-only wrapping
    return;
  }

  liteState.set(messageEl, { originalHTML });
  messageEl.classList.add('gcwb-auto-lite');

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
