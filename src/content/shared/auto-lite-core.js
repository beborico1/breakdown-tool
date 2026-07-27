import { debugLog } from '../core/debug.js';
import { hasJapanese, segmentClauses, MIN_SYNTHETIC_CLAUSE_CHARS } from '../utils/text.js';
import { wrapJapaneseTokensInTextNode } from '../utils/auto-token-mapper.js';
import { isBlockLevel } from './block-walker.js';

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
 * With `stopAtNestedBlocks`, nested block-level subtrees are excluded too and
 * replaced by a synthetic '\n' seam in `assembled` that has NO range entry:
 * the unit is exactly the text that belongs to this block, and no analyzer
 * token can span the seam (kuromoji surfaces never contain '\n'). `<br>` is a
 * hard visual line break and seams the same way. Excluded tags and
 * display:none subtrees produce no seam — inline holes like a skipped `<sup>`
 * or a hidden reading span must let the surrounding base text join seamlessly
 * (hidden elements own their text as separate units and paint on reveal).
 *
 * @param {HTMLElement} blockEl
 * @param {Set<string>} [excludeTags] - uppercase tag names whose subtrees to skip
 * @param {{stopAtNestedBlocks?: boolean}} [opts]
 * @returns {{ assembled: string, ranges: Array<{node: Text, start: number, end: number}> }}
 */
export function collectBlockTextNodes(blockEl, excludeTags = DEFAULT_EXCLUDE_TAGS, opts = {}) {
  const { stopAtNestedBlocks = false } = opts;
  const styleCache = stopAtNestedBlocks ? new Map() : null;
  const ranges = [];
  let assembled = '';
  let pendingSeam = false;

  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (excludeTags.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        if (node.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (node.getAttribute?.('role') === 'textbox') return NodeFilter.FILTER_REJECT;
        if (node.dataset?.gcwbSkip != null) return NodeFilter.FILTER_REJECT;
        if (node.classList?.contains('gcwb-auto-word')) return NodeFilter.FILTER_REJECT;
        if (node.classList?.contains('gcwb-cached-word')) return NodeFilter.FILTER_REJECT;
        if (stopAtNestedBlocks) {
          if (node.tagName === 'BR') {
            pendingSeam = true;
            return NodeFilter.FILTER_REJECT;
          }
          let d = '';
          try { d = getComputedStyle(node).display || ''; } catch { /* keep '' */ }
          if (d === 'none') return NodeFilter.FILTER_REJECT; // hidden: no seam
          // Hand the resolved display to isBlockLevel so it does not resolve
          // style a second time for the same node on its first visit.
          if (isBlockLevel(node, styleCache, d)) {
            pendingSeam = true;
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_SKIP; // descend; only text nodes are emitted
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const val = node.nodeValue || '';
    if (!val) continue;
    if (pendingSeam) {
      if (assembled) assembled += '\n'; // no range entry: a gap no token can span
      pendingSeam = false;
    }
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
 * @param {{marker?: string, excludeTags?: Set<string>, translation?: string, boundaryDots?: boolean, marks?: 'ja'|'ja-ascii', stopAtNestedBlocks?: boolean, decorateNativeRuby?: boolean}} [opts]
 *   `boundaryDots` wraps each Japanese clause's closing mark as a hoverable dot,
 *   and hangs an empty dot off a clause that has no closing mark.
 *   `marks` selects the clause-ending punctuation policy.
 *   `translation` (optional) describes the whole block, so it is only used to
 *   seed a dot when the block holds exactly one Japanese clause; otherwise dots
 *   carry their clause text and resolve their own English on hover.
 *   `stopAtNestedBlocks` must match the collectBlockTextNodes call that built
 *   `analyzerText`, or the offset-safety check fails on every nested block.
 *   `decorateNativeRuby` copies painted base colors onto excluded <rt> readings.
 * @returns {boolean} whether any word tokens were painted
 */
export function paintBlockTokens(blockEl, analyzerText, words, opts = {}) {
  const {
    marker = 'gcwbAuto',
    excludeTags = DEFAULT_EXCLUDE_TAGS,
    translation = '',
    boundaryDots = true,
    marks = 'ja',
    stopAtNestedBlocks = false,
    decorateNativeRuby = false,
  } = opts;
  if (!blockEl || !Array.isArray(words) || words.length === 0) return false;

  const { assembled, ranges } = collectBlockTextNodes(blockEl, excludeTags, { stopAtNestedBlocks });

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
      // The analyzer's no-token fallback word is the whole chunk text and can
      // contain a synthetic seam; it must never wrap across the gap.
      if (surface.includes('\n')) continue;

      const start = assembled.indexOf(surface, searchPos);
      if (start < 0) continue; // unlocatable; skip rather than corrupt
      const end = start + surface.length;
      searchPos = end; // monotonic, so repeated surfaces resolve in order

      if (!hasJapanese(surface)) continue;

      // Advance rangeIdx until the current range can contain `start`.
      while (rangeIdx < ranges.length && ranges[rangeIdx].end <= start) {
        rangeIdx++;
      }
      if (!ranges[rangeIdx]) continue;
      if (start < ranges[rangeIdx].start) continue; // starts inside a seam gap

      // Split [start, end) across consecutive ranges. A token that straddles
      // text-node boundaries (kanji inside a wrapper span, okurigana outside)
      // becomes one segment per node, each carrying the full word metadata.
      const segs = [];
      let pos = start;
      let segIdx = rangeIdx;
      let ok = true;
      while (pos < end) {
        const sr = ranges[segIdx];
        if (!sr || pos < sr.start) { ok = false; break; } // gap mid-token: bail
        const segEnd = Math.min(end, sr.end);
        if (segEnd <= pos) { ok = false; break; } // defensive: no empty segments
        segs.push({ node: sr.node, start: pos - sr.start, end: segEnd - sr.start, from: pos, to: segEnd });
        pos = segEnd;
        if (pos < end) segIdx++;
      }
      if (!ok || segs.length === 0) continue;
      rangeIdx = segIdx; // last range may still hold the next word's start

      const multi = segs.length > 1;
      for (const seg of segs) {
        const bucket = buckets.get(seg.node) || [];
        bucket.push({
          surface: assembled.slice(seg.from, seg.to), // exact node-local slice
          start: seg.start,
          end: seg.end,
          word: multi ? surface : undefined, // full word for dataset/tooltip
          reading: w.reading,
          romaji: w.romaji,
          english: w.english,
          type: w.type
        });
        buckets.set(seg.node, bucket);
      }
    }

    // Clause-ending dots → hoverable boundary spans. Each dot carries its own
    // clause in data-clause and resolves that clause's English on hover, so a
    // dot never reveals a neighbouring clause. Bucketed per node like words.
    if (boundaryDots) {
      const clauses = segmentClauses(assembled, { marks }).filter(c => c.hasJapanese);

      // A block translation describes the whole block, so it is only honestly
      // this clause's English when the block holds exactly one clause. With more
      // the dots start empty and resolve themselves.
      const seed = clauses.length === 1 ? (translation || '').trim() : '';

      let bRangeIdx = 0;
      const rangeContaining = (pos) => {
        while (bRangeIdx < ranges.length && ranges[bRangeIdx].end <= pos) bRangeIdx++;
        return ranges[bRangeIdx];
      };

      for (const c of clauses) {
        if (c.terminated) {
          const r = rangeContaining(c.markStart);
          if (!r) continue;
          if (c.markStart < r.start || c.markEnd > r.end) continue; // straddles nodes
          // An earlier pass may already have wrapped this mark. Re-wrapping it
          // would nest a dot inside a dot, so skip rather than reject the mark
          // during assembly, which would leave `assembled` unstable.
          if (r.node.parentElement?.closest('.gcwb-auto-boundary')) continue;
          const bucket = buckets.get(r.node) || [];
          bucket.push({
            surface: assembled.slice(c.markStart, c.markEnd),
            start: c.markStart - r.start,
            end: c.markEnd - r.start,
            isBoundary: true,
            clause: c.text,
            english: seed,
          });
          buckets.set(r.node, bucket);
          continue;
        }

        // Unterminated: hang an empty dot off the end of the clause's text so a
        // phrase with no closing mark is still hoverable. The span holds no text
        // node, so the assembled text is byte-identical on the next pass.
        if (c.text.length < MIN_SYNTHETIC_CLAUSE_CHARS) continue;
        const r = rangeContaining(c.contentEnd - 1);
        if (!r || r.end !== c.contentEnd) continue;
        if (isFollowedBySyntheticDot(r.node)) continue;
        const bucket = buckets.get(r.node) || [];
        bucket.push({
          surface: '',
          start: r.end - r.start,
          end: r.end - r.start,
          isBoundary: true,
          synthetic: true,
          clause: c.text,
          english: seed,
        });
        buckets.set(r.node, bucket);
      }
    }

    for (const [node, tokens] of buckets.entries()) {
      // Boundaries are appended after words, so re-sort each bucket by local
      // offset before wrapping (wrapJapaneseTokensInTextNode consumes in order).
      // The end tiebreak keeps a zero-length synthetic dot behind a real token
      // that starts at the same offset.
      tokens.sort((a, b) => (a.start - b.start) || (a.end - b.end));
      const hasWord = tokens.some(t => !t.isBoundary);
      try {
        wrapJapaneseTokensInTextNode(node, tokens, { decorateNativeRuby });
        if (hasWord) painted = true;
      } catch (e) {
        debugLog('AUTO-LITE-CORE', 'wrap failed:', e?.message);
      }
    }

    if (boundaryDots) hoistSyntheticDots(blockEl);
  }

  if (marker) blockEl.dataset[marker] = '1';
  return painted;
}

/** Elements a bare dot must not sit inside, by tag. */
const DOT_HOSTILE_TAGS = new Set(['A', 'BUTTON', 'LABEL', 'SUMMARY', 'RUBY', 'RB', 'RT', 'RP', 'RTC']);

/**
 * True when `node` is already followed by a synthetic dot, ignoring empty text
 * nodes left behind by splitText. Keeps a repaint from stacking a second dot.
 * @param {Text} node
 * @returns {boolean}
 */
function isFollowedBySyntheticDot(node) {
  let sib = node.nextSibling;
  while (sib && sib.nodeType === Node.TEXT_NODE && !sib.nodeValue) sib = sib.nextSibling;
  return !!(sib && sib.nodeType === Node.ELEMENT_NODE
    && sib.classList?.contains('gcwb-auto-boundary')
    && sib.dataset?.gcwbSynth != null);
}

/**
 * Move synthetic dots out of elements that would mis-render or mis-handle them.
 * Inside a <ruby> a bare span lays out as a second base and shifts the reading
 * off its kanji; inside an <a> or <button> the dot inherits the click target.
 * The dot is re-parented just after the outermost hostile ancestor still within
 * the block, so it keeps its reading order.
 * @param {HTMLElement} blockEl
 */
function hoistSyntheticDots(blockEl) {
  const dots = blockEl.querySelectorAll('.gcwb-auto-boundary[data-gcwb-synth]');
  for (const dot of dots) {
    let outermost = null;
    for (let el = dot.parentElement; el && el !== blockEl; el = el.parentElement) {
      if (DOT_HOSTILE_TAGS.has(el.tagName)) outermost = el;
    }
    if (outermost?.parentNode) outermost.parentNode.insertBefore(dot, outermost.nextSibling);
  }
}
