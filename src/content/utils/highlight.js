import { getWordTypeClass } from './text.js';

/**
 * Shared Highlight Primitives
 * Used by both Google Chat and Gmail word highlighting modules
 */

/**
 * Collect text nodes from a root element using TreeWalker, skipping:
 * - Nodes inside the exclude container (e.g. quoted blocks)
 * - Nodes inside hidden spans (display: none)
 * - Nodes inside already-highlighted spans (.gcwb-cached-word)
 * @param {HTMLElement} root - Root element to walk
 * @param {HTMLElement|null} excludeContainer - Container to skip
 * @returns {Text[]} - Array of text nodes to process
 */
export function collectTextNodes(root, excludeContainer) {
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
        // Skip nodes inside already-highlighted spans
        if (parentEl.closest('.gcwb-cached-word')) {
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
    span.className = `gcwb-cached-word gcwb-type-${typeClass}`;
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
  }
}
