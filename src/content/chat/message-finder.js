import { debugLog } from '../core/debug.js';
import { collectTextNodes } from '../utils/highlight.js';

/**
 * Detect if current page is Google Chat
 * @returns {boolean}
 */
export function isGoogleChat() {
  return window.location.hostname === 'chat.google.com' ||
         (window.location.hostname === 'mail.google.com' &&
           (window.location.pathname.startsWith('/chat') || window.location.hash.startsWith('#chat')));
}

/**
 * Find the message element from a click target
 * Google Chat uses .Zc1Emd for message text, nested in .nF6pT containers
 * @param {HTMLElement} target - Click target element
 * @returns {HTMLElement|null} - Message element or null
 */
export function findChatMessageElement(target) {
  debugLog('GCWB-FIND', 'Looking for message element from target:', target.className || target.nodeName);

  // Direct check - target itself has .Zc1Emd class
  if (target.classList?.contains('Zc1Emd')) {
    debugLog('GCWB-FIND', 'Target itself is .Zc1Emd');
    return target;
  }

  // Target is inside a .Zc1Emd element
  let messageEl = target.closest('.Zc1Emd');
  if (messageEl) {
    debugLog('GCWB-FIND', 'Found via closest .Zc1Emd');
    return messageEl;
  }

  // Check if inside a message container with data-is-message
  const messageContainer = target.closest('[data-is-message="true"]');
  if (messageContainer) {
    messageEl = messageContainer.querySelector('.Zc1Emd');
    if (messageEl) {
      debugLog('GCWB-FIND', 'Found via data-is-message container');
      return messageEl;
    }
  }

  // Check parent message bubble (.nF6pT is the outer message container)
  const bubbleContainer = target.closest('.nF6pT');
  if (bubbleContainer) {
    messageEl = bubbleContainer.querySelector('.Zc1Emd');
    if (messageEl) {
      debugLog('GCWB-FIND', 'Found via .nF6pT container');
      return messageEl;
    }
  }

  // Check for .YJxKBc which wraps the message content area
  const contentWrapper = target.closest('.YJxKBc');
  if (contentWrapper) {
    messageEl = contentWrapper.querySelector('.Zc1Emd');
    if (messageEl) {
      debugLog('GCWB-FIND', 'Found via .YJxKBc wrapper');
      return messageEl;
    }
  }

  // Fallback: look for .DTp27d (another class on message divs)
  messageEl = target.closest('.DTp27d');
  if (messageEl) {
    debugLog('GCWB-FIND', 'Found via .DTp27d fallback');
    return messageEl;
  }

  debugLog('GCWB-FIND', 'No message element found');
  return null;
}

/**
 * Walk up from a node until its parent is root, returning the direct child of
 * root that contains it. Returns null if root never appears in the ancestor chain.
 */
function walkUpToDirectChild(node, root) {
  let current = node;
  while (current && current.parentElement && current.parentElement !== root) {
    current = current.parentElement;
  }
  return current && current.parentElement === root ? current : null;
}

/**
 * Find the quoted-reply preview container inside a Google Chat message.
 * Returns the direct child of messageEl that wraps the quoted preview, or null.
 *
 * Google wraps the preview in a div with aria-hidden="true" whose descendants
 * include spans with the accessibility text "Quoted" / "End Quote". Class names
 * (wVNE5, Oq47ld, Lphf0c, cPjwNc, …) are obfuscated and change, so we match on
 * the stable semantic cues instead, tried in order:
 *   1. <blockquote> or [role="blockquote"].
 *   2. Element with aria-label matching /quot|reply/i.
 *   3. Element whose trimmed text is exactly "quoted" / "end quote" — handles
 *      both `<span style="display:none">` and class-hidden variants.
 *   4. Direct child of messageEl marked aria-hidden="true" with substantial text.
 *   5. Direct child containing an <img> (quoted speaker avatar) plus text.
 */
export function findQuotedBlockContainer(messageEl) {
  // 1. Semantic blockquote
  const blockquote = messageEl.querySelector('blockquote, [role="blockquote"]');
  if (blockquote) {
    const child = walkUpToDirectChild(blockquote, messageEl);
    if (child) return child;
  }

  // 2. aria-label hint
  for (const el of messageEl.querySelectorAll('[aria-label]')) {
    if (/quot|reply/i.test(el.getAttribute('aria-label') || '')) {
      const child = walkUpToDirectChild(el, messageEl);
      if (child) return child;
    }
  }

  // 3. Accessibility marker text, regardless of how it's hidden
  for (const el of messageEl.querySelectorAll('span')) {
    const text = el.textContent?.trim().toLowerCase() || '';
    if (text === 'quoted' || text === 'end quote' || text === 'quoted text' || text.startsWith('end quote')) {
      const child = walkUpToDirectChild(el, messageEl);
      if (child) return child;
    }
  }

  // 4. aria-hidden direct child with visible text (Google's current wrapper)
  for (const child of messageEl.children) {
    if (child.getAttribute?.('aria-hidden') === 'true' && (child.textContent?.trim().length || 0) > 0) {
      return child;
    }
  }

  // 5. Structural fallback: direct child with an avatar image and some text
  for (const child of messageEl.children) {
    if (child.querySelector?.('img') && (child.textContent?.trim().length || 0) > 0) {
      return child;
    }
  }

  debugLog('GCWB-FIND', 'No quoted block detected; messageEl outerHTML:', messageEl.outerHTML.slice(0, 600));
  return null;
}

/**
 * Extract text from a Google Chat message element.
 * Uses the same TreeWalker + exclusion pattern as highlighting so nested
 * quoted previews and hidden accessibility spans are reliably dropped.
 * @param {HTMLElement} messageEl - Message element
 * @returns {string} - Message text
 */
export function extractChatMessageText(messageEl) {
  const quoted = findQuotedBlockContainer(messageEl);
  // includeHighlighted: cached-word highlight spans must NOT be stripped here,
  // or the LLM receives a mutilated message and produces a nonsense translation.
  const textNodes = collectTextNodes(messageEl, quoted, { includeHighlighted: true });
  return textNodes.map(n => n.nodeValue).join('').trim();
}
