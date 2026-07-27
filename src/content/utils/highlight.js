import { getWordTypeClass } from './text.js';

/**
 * Shared Highlight Primitives
 * Used by both Google Chat and Gmail word highlighting modules
 */

/**
 * Collect text nodes from a root element using TreeWalker, skipping:
 * - Nodes inside the exclude container (e.g. quoted blocks)
 * - Nodes inside hidden spans (display: none)
 * - Nodes inside already-highlighted spans (.gcwb-cached-word) — unless
 *   `options.includeHighlighted` is true (used by plain-text extractors that
 *   need the full original message regardless of highlighting state)
 * @param {HTMLElement} root - Root element to walk
 * @param {HTMLElement|null} excludeContainer - Container to skip
 * @param {{includeHighlighted?: boolean}} [options]
 * @returns {Text[]} - Array of text nodes to process
 */
export function collectTextNodes(root, excludeContainer, options = {}) {
  const { includeHighlighted = false } = options;
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip nodes inside excluded container
      if (excludeContainer && excludeContainer.contains(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip nodes inside hidden spans
      const parentEl = node.parentElement;
      if (parentEl) {
        if (parentEl.style?.display === 'none' ||
            parentEl.closest('span[style*="display: none"], span[style*="display:none"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip nodes inside already-highlighted spans (highlighter-only — text
        // extractors must opt in via includeHighlighted to receive the full text)
        if (!includeHighlighted && parentEl.closest('.gcwb-cached-word')) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }
  return textNodes;
}

/**
 * Apply word highlights to a single text node by splitting it and wrapping
 * matched portions in styled spans. Uses DOM APIs (splitText + createElement)
 * to preserve surrounding HTML structure.
 * @param {Text} textNode - Text node to process
 * @param {Array<{word: string, start: number, end: number, data: Object}>} matches - Sorted matches
 */
export function applyHighlightsToTextNode(textNode, matches) {
  if (matches.length === 0) return;

  const parent = textNode.parentNode;
  if (!parent) return;

  let currentNode = textNode;
  let consumedOffset = 0;
  let prevMatch = null;
  let tone = 0;

  for (const match of matches) {
    const relativeStart = match.start - consumedOffset;
    const wordLength = match.word.length;

    // Split off the text before the match (if any)
    if (relativeStart > 0) {
      currentNode = currentNode.splitText(relativeStart);
      consumedOffset += relativeStart;
    }

    // Split off the text after the match
    const afterNode = currentNode.splitText(wordLength);
    consumedOffset += wordLength;

    // Create the highlight span
    const typeClass = getWordTypeClass(match.data.type);
    const span = document.createElement('span');
    const sameRun = prevMatch
      && match.start === prevMatch.end
      && match.data.type
      && match.data.type === prevMatch.data.type;
    tone = sameRun ? 1 - tone : 0;
    span.className = `gcwb-cached-word gcwb-type-${typeClass}${tone === 1 ? ' gcwb-tone-alt' : ''}`;
    span.dataset.word = match.word;
    span.dataset.reading = match.data.reading || '';
    span.dataset.romaji = match.data.romaji || '';
    span.dataset.english = match.data.english || '';
    span.dataset.type = match.data.type || '';

    // Replace the current text node with the span
    parent.replaceChild(span, currentNode);
    span.appendChild(document.createTextNode(match.word));

    // Continue processing from the remaining text after the match
    currentNode = afterNode;
    prevMatch = match;
  }
}

/**
 * Build a hoverable clause-boundary span. `data-clause` holds the clause this
 * dot closes, which is what the tooltip translates on hover; `data-english`
 * holds that translation once known, and starts empty unless the caller had an
 * honest one to seed. Deliberately has no data-word, so the Anki / context-menu
 * word selectors never treat a boundary dot as a word.
 * @param {string} translation - English to reveal immediately, if already known
 * @param {{clause?: string, synthetic?: boolean}} [options]
 *   `clause` is the text the dot resolves on hover.
 *   `synthetic` marks a dot standing in for a closing mark the text never had;
 *   it renders its glyph from CSS and holds no text of its own.
 * @returns {HTMLSpanElement}
 */
export function createAutoBoundarySpan(translation, options = {}) {
  const { clause = '', synthetic = false } = options;
  const span = document.createElement('span');
  span.className = 'gcwb-auto-boundary';
  span.dataset.english = translation || '';
  if (clause) span.dataset.clause = clause;
  if (synthetic) span.dataset.gcwbSynth = '1';
  return span;
}

/**
 * Apply auto-analyze (lite view) word spans to a single text node, splitting it and
 * wrapping matched portions in `gcwb-auto-word` spans. Uses the same DOM-preserving
 * splitText technique as applyHighlightsToTextNode so sibling structure (mention
 * chips, links, etc.) is never touched. A match with `kind: 'boundary'` is wrapped
 * as a sentence-boundary dot instead (single punctuation char, translation only).
 * @param {Text} textNode - Text node to process
 * @param {Array<{kind?: string, word: string, start: number, end: number, data: Object}>} matches - Sorted, non-overlapping matches local to this node
 */
export function applyAutoWordsToTextNode(textNode, matches) {
  if (matches.length === 0) return;

  const parent = textNode.parentNode;
  if (!parent) return;

  let currentNode = textNode;
  let consumedOffset = 0;
  let prevMatch = null;
  let tone = 0;

  for (const match of matches) {
    const relativeStart = match.start - consumedOffset;
    const wordLength = match.word.length;

    if (relativeStart > 0) {
      currentNode = currentNode.splitText(relativeStart);
      consumedOffset += relativeStart;
    }

    const afterNode = currentNode.splitText(wordLength);
    consumedOffset += wordLength;

    if (match.kind === 'boundary') {
      const span = createAutoBoundarySpan(match.data.english, {
        clause: match.data.clause,
        synthetic: match.data.synthetic,
      });
      parent.replaceChild(span, currentNode);
      if (match.word) span.appendChild(document.createTextNode(match.word));
      currentNode = afterNode;
      // A boundary is a hard break: don't carry the tone run across it, so the
      // next same-type word restarts its alternation (like plain punctuation).
      prevMatch = null;
      tone = 0;
      continue;
    }

    const typeClass = getWordTypeClass(match.data.type);
    const span = document.createElement('span');
    const sameRun = prevMatch
      && match.start === prevMatch.end
      && match.data.type
      && match.data.type === prevMatch.data.type;
    tone = sameRun ? 1 - tone : 0;
    span.className = `gcwb-auto-word gcwb-type-${typeClass}${tone === 1 ? ' gcwb-tone-alt' : ''}`;
    span.dataset.word = match.word;
    span.dataset.reading = (match.data.reading || '').trim() || match.word;
    span.dataset.romaji = (match.data.romaji || '').trim() || '-';
    span.dataset.english = (match.data.english || '').trim() || '-';
    span.dataset.type = typeClass;

    parent.replaceChild(span, currentNode);
    span.appendChild(document.createTextNode(match.word));

    currentNode = afterNode;
    prevMatch = match;
  }
}
