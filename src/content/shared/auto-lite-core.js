import { debugLog } from '../core/debug.js';
import { hasJapanese, findSentenceBoundaries } from '../utils/text.js';
import { wrapJapaneseTokensInTextNode } from '../utils/auto-token-mapper.js';

/**
 * Shared Auto-Lite Core
 * Domain-agnostic primitives for the "lite view" (per-word coloring): assemble a
 * block's text nodes and wrap analyzer tokens in `.gcwb-auto-word` spans in place.
 * Used by both the Redmine renderer and the universal (all-sites) colorizer.
 */

// Default tag subtrees excluded from text assembly. Callers pass their own set.
export const DEFAULT_EXCLUDE_TAGS = new Set(['PRE', 'CODE', 'IMG', 'OBJECT']);

/**
 * Walk text nodes inside blockEl in document order, skipping excluded-tag
 * subtrees, contenteditable regions, and existing word spans. Returns the
 * assembled text plus a parallel range table so analyzer offsets can be mapped
 * back to specific text nodes.
 *
 * @param {HTMLElement} blockEl
 * @param {Set<string>} [excludeTags] - uppercase tag names whose subtrees to skip
 * @returns {{ assembled: string, ranges: Array<{node: Text, start: number, end: number}> }}
 */
export function collectBlockTextNodes(blockEl, excludeTags = DEFAULT_EXCLUDE_TAGS) {
  const ranges = [];
  let assembled = '';

  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== blockEl) {
        if (excludeTags.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (p.getAttribute?.('role') === 'textbox') return NodeFilter.FILTER_REJECT;
        if (p.dataset?.gcwbSkip != null) return NodeFilter.FILTER_REJECT;
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
 * Re-anchor analyzer words against the block's current text and wrap each
 * Japanese token in a `.gcwb-auto-word` span, in place. Sets a dataset marker so
 * the block is not re-processed.
 *
 * kuromoji output is lossy (whitespace dropped, punctuation tokens filtered), so
 * offsets can't be rebuilt by summing surface lengths — that drifts backward and
 * splices kanji into earlier runs. Each surface is located by forward-searching
 * from a monotonic cursor to re-sync over dropped characters and recover the true
 * offset into the assembled text. Skips painting if the assembled text no longer
 * matches what was analyzed (the DOM may have changed since analysis started).
 *
 * @param {HTMLElement} blockEl
 * @param {string} analyzerText - the exact text passed to the analyzer
 * @param {Array<{japanese:string,reading:string,romaji:string,english:string,type:string}>} words
 * @param {{marker?: string, excludeTags?: Set<string>, translation?: string}} [opts]
 *   `translation` (optional): when set, sentence-ending dots are wrapped as
 *   hoverable boundary spans revealing this whole-message translation.
 * @returns {boolean} whether any word tokens were painted
 */
export function paintBlockTokens(blockEl, analyzerText, words, opts = {}) {
  const { marker = 'gcwbAuto', excludeTags = DEFAULT_EXCLUDE_TAGS, translation = '' } = opts;
  if (!blockEl || !Array.isArray(words) || words.length === 0) return false;

  const { assembled, ranges } = collectBlockTextNodes(blockEl, excludeTags);

  const offsetSafe = assembled === analyzerText;
  if (!offsetSafe) {
    debugLog('AUTO-LITE-CORE', 'assembled text drift; skipping token wrap');
  }

  let painted = false;

  if (offsetSafe) {
    // Bucket Japanese tokens by the text node that contains them.
    const buckets = new Map(); // node -> tokens[]
    let searchPos = 0; // chars of `assembled` already consumed, in order
    let rangeIdx = 0;

    for (const w of words) {
      const surface = w.japanese ?? '';
      if (!surface) continue;

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

    // Sentence-ending dots → hoverable boundary spans showing the whole-message
    // translation (mirrors the Meet hover-dot feature). Bucketed per node like
    // words; only built when a translation is available to reveal on hover.
    const trans = (translation || '').trim();
    if (trans) {
      let bRangeIdx = 0;
      for (const { start, end } of findSentenceBoundaries(assembled)) {
        while (bRangeIdx < ranges.length && ranges[bRangeIdx].end <= start) bRangeIdx++;
        const r = ranges[bRangeIdx];
        if (!r) continue;
        if (start < r.start || end > r.end) continue; // straddles a node boundary
        const bucket = buckets.get(r.node) || [];
        bucket.push({
          surface: assembled.slice(start, end),
          start: start - r.start,
          end: end - r.start,
          isBoundary: true,
          english: trans,
        });
        buckets.set(r.node, bucket);
      }
    }

    for (const [node, tokens] of buckets.entries()) {
      // Boundaries are appended after words, so re-sort each bucket by local
      // offset before wrapping (wrapJapaneseTokensInTextNode consumes in order).
      tokens.sort((a, b) => a.start - b.start);
      const hasWord = tokens.some(t => !t.isBoundary);
      try {
        wrapJapaneseTokensInTextNode(node, tokens);
        if (hasWord) painted = true;
      } catch (e) {
        debugLog('AUTO-LITE-CORE', 'wrap failed:', e?.message);
      }
    }
  }

  if (marker) blockEl.dataset[marker] = '1';
  return painted;
}
