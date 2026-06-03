import { debugLog } from '../core/debug.js';
import { hasJapanese } from '../utils/text.js';
import { wrapJapaneseTokensInTextNode } from '../utils/auto-token-mapper.js';
import { buildTogglePanel } from '../core/auto-translate-panel.js';

const EXCLUDE_TAGS = new Set(['PRE', 'CODE', 'IMG', 'OBJECT']);

const CONTAINER_SELECTOR = '.subject, .description, .journal, .wiki-page, .news, #activity dd';

/**
 * Walk text nodes inside blockEl in document order, skipping pre/code/img/object
 * subtrees, and return the assembled text plus a parallel range table so we can
 * map analyzer offsets back to specific text nodes.
 *
 * @param {HTMLElement} blockEl
 * @returns {{ assembled: string, ranges: Array<{node: Text, start: number, end: number}> }}
 */
function collectBlockTextNodes(blockEl) {
  const ranges = [];
  let assembled = '';

  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== blockEl) {
        if (EXCLUDE_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.classList?.contains('gcwb-auto-word')) return NodeFilter.FILTER_REJECT;
        if (p.classList?.contains('gcwb-cached-word')) return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const val = node.nodeValue || '';
    if (!val) continue;
    const start = assembled.length;
    assembled += val;
    ranges.push({ node, start, end: assembled.length });
  }

  return { assembled, ranges };
}

/**
 * Public helper used by auto-analyze.js to build the analyzer-input string
 * with the same exclusions and ordering the renderer will use.
 *
 * @param {HTMLElement} blockEl
 * @returns {string}
 */
export function assembleRedmineText(blockEl) {
  return collectBlockTextNodes(blockEl).assembled;
}

function findContainer(blockEl) {
  return blockEl.closest(CONTAINER_SELECTOR) || blockEl;
}

/**
 * Render the lite auto-analyze view for a Redmine block: in-place per-word
 * coloring + thin spaces + chevron toggle on top-right of a sensible container
 * + collapsible purple translation panel.
 *
 * @param {HTMLElement} blockEl - The Redmine text block element.
 * @param {string} analyzerText - The exact text passed to the analyzer.
 * @param {{words:Array,translation:string,original?:string}} breakdownData
 */
export function renderRedmineAutoLite(blockEl, analyzerText, breakdownData) {
  if (!blockEl || !breakdownData?.words?.length) return;
  if (blockEl.dataset.gcwbAutoLite === '1') return;
  if (blockEl.querySelector('.gcwb-auto-word')) return;

  const { assembled, ranges } = collectBlockTextNodes(blockEl);

  const offsetSafe = assembled === analyzerText;
  if (!offsetSafe) {
    debugLog('REDMINE-AUTO-LITE', 'assembled text drift; skipping token wrap');
  }

  if (offsetSafe) {
    // Bucket Japanese tokens by the text node that contains them.
    const buckets = new Map(); // node -> tokens[]
    let searchPos = 0; // chars of `assembled` already consumed, in order
    let rangeIdx = 0;

    for (const w of breakdownData.words) {
      const surface = w.japanese ?? '';
      if (!surface) continue;

      // Analyzer output is lossy (kuromoji drops whitespace; punctuation tokens
      // are filtered), so offsets can't be rebuilt by summing surface lengths —
      // that drifts backward and splices kanji into earlier runs. Search forward
      // from searchPos to re-sync over any dropped characters and recover the
      // true offset into the assembled text.
      const start = assembled.indexOf(surface, searchPos);
      if (start < 0) continue; // unlocatable; skip rather than corrupt
      const end = start + surface.length;
      searchPos = end; // monotonic, so repeated surfaces resolve in order

      if (!hasJapanese(surface)) continue;

      // Advance rangeIdx until the current range can contain [start, end).
      while (rangeIdx < ranges.length && ranges[rangeIdx].end <= start) {
        rangeIdx++;
      }
      const r = ranges[rangeIdx];
      if (!r) continue;
      if (start < r.start || end > r.end) continue; // straddles a node boundary

      const localStart = start - r.start;
      const localEnd = end - r.start;
      const bucket = buckets.get(r.node) || [];
      bucket.push({
        surface,
        start: localStart,
        end: localEnd,
        reading: w.reading,
        romaji: w.romaji,
        english: w.english,
        type: w.type
      });
      buckets.set(r.node, bucket);
    }

    for (const [node, tokens] of buckets.entries()) {
      try {
        wrapJapaneseTokensInTextNode(node, tokens);
      } catch (e) {
        debugLog('REDMINE-AUTO-LITE', 'wrap failed:', e?.message);
      }
    }
  }

  blockEl.dataset.gcwbAutoLite = '1';

  const translation = (breakdownData.translation || '').trim();
  if (!translation) return;

  const containerEl = findContainer(blockEl);
  if (containerEl.querySelector(':scope > .gcwb-auto-translate-toggle')) return;
  containerEl.classList.add('gcwb-auto-bubble');
  const { btn, panel } = buildTogglePanel(translation);
  containerEl.appendChild(btn);
  containerEl.appendChild(panel);
}
