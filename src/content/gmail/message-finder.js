import { debugLog } from '../core/debug.js';

/**
 * Detect if current page is Gmail (not Gmail Chat)
 * @returns {boolean}
 */
export function isGmail() {
  return window.location.hostname === 'mail.google.com' &&
         !window.location.pathname.startsWith('/chat');
}

/**
 * Find the Gmail message body element from a click target
 * Gmail uses .a3s.aiL for rendered message bodies
 * @param {HTMLElement} target - Click target element
 * @returns {HTMLElement|null} - Message body element or null
 */
export function findGmailMessageElement(target) {
  debugLog('GMAIL-FIND', 'Looking for message element from target:', target.className || target.nodeName);

  // Direct check - target itself is a message body
  if (target.classList?.contains('a3s') && target.classList?.contains('aiL')) {
    debugLog('GMAIL-FIND', 'Target itself is .a3s.aiL');
    return target;
  }

  // Target is inside a message body — try to find a focused block-level element first
  let messageBody = target.closest('.a3s.aiL');
  if (messageBody) {
    const focusSelectors = ['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'dd', 'dt'];
    for (const sel of focusSelectors) {
      const el = target.closest(sel);
      if (el && messageBody.contains(el)) {
        debugLog('GMAIL-FIND', `Found focused <${sel}> within message body`);
        return el;
      }
    }
    // Try <div> as fallback for plain-text emails (Gmail wraps each line in a div).
    // Only match "leaf" divs that don't contain other block elements (avoids wrapper divs).
    const divEl = target.closest('div');
    if (divEl && divEl !== messageBody && messageBody.contains(divEl)) {
      if (!divEl.querySelector('div, p, ul, ol, table, blockquote')) {
        debugLog('GMAIL-FIND', 'Found focused <div> (leaf) within message body');
        return divEl;
      }
    }

    debugLog('GMAIL-FIND', 'Found via closest .a3s.aiL');
    return messageBody;
  }

  let messageEl;

  // Check body parent (.ii.gt)
  const bodyParent = target.closest('.ii.gt');
  if (bodyParent) {
    messageEl = bodyParent.querySelector('.a3s.aiL');
    if (messageEl) {
      debugLog('GMAIL-FIND', 'Found via .ii.gt parent');
      return messageEl;
    }
  }

  // Check message container (.adn.ads)
  const messageContainer = target.closest('.adn.ads');
  if (messageContainer) {
    messageEl = messageContainer.querySelector('.a3s.aiL');
    if (messageEl) {
      debugLog('GMAIL-FIND', 'Found via .adn.ads container');
      return messageEl;
    }
  }

  debugLog('GMAIL-FIND', 'No message element found');
  return null;
}

/**
 * Extract text from a Gmail message body element.
 * Strips quoted replies, signatures, and non-text elements.
 * @param {HTMLElement} messageEl - Message body element
 * @returns {string} - Message text
 */
export function extractGmailMessageText(messageEl) {
  // Clone to avoid modifying original
  const clone = messageEl.cloneNode(true);

  // Remove quoted replies
  clone.querySelectorAll('.gmail_quote').forEach(el => el.remove());

  // Remove signatures
  clone.querySelectorAll('.gmail_signature').forEach(el => el.remove());

  // Remove images and style elements
  clone.querySelectorAll('img, style').forEach(el => el.remove());

  // Convert <br> to newlines so line structure is preserved
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

  let text = clone.textContent?.trim() || '';

  // Also check for trimmed/hidden content within the same message container
  const messageContainer = messageEl.closest('.adn.ads');
  if (messageContainer) {
    const allBodies = messageContainer.querySelectorAll('.a3s');
    for (const body of allBodies) {
      if (body === messageEl) continue;
      const hiddenClone = body.cloneNode(true);
      hiddenClone.querySelectorAll('.gmail_quote').forEach(el => el.remove());
      hiddenClone.querySelectorAll('.gmail_signature, img, style').forEach(el => el.remove());
      hiddenClone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      const hiddenText = hiddenClone.textContent?.trim();
      if (hiddenText) {
        text += '\n' + hiddenText;
      }
    }
  }

  return text;
}

/**
 * Extract the text of the br-separated line containing the target element.
 * For plain-text emails where lines are separated by <br>, not wrapped in block elements.
 * @param {HTMLElement} target - Click target
 * @param {HTMLElement} container - Message body container
 * @returns {string|null} - Line text, or null if not br-separated content
 */
export function extractBrSeparatedLine(target, container) {
  const brs = Array.from(container.querySelectorAll('br'));
  if (brs.length === 0) return null;

  // Find the last <br> before target and first <br> after target (document order)
  let brBefore = null;
  let brAfter = null;

  for (const br of brs) {
    const position = target.compareDocumentPosition(br);
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      brBefore = br;  // keep updating → last br before target
    } else if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      if (!brAfter) brAfter = br;  // first br after target
    }
  }

  // Build a range between the br boundaries
  const range = document.createRange();
  if (brBefore) {
    range.setStartAfter(brBefore);
  } else {
    range.setStart(container, 0);
  }
  if (brAfter) {
    range.setEndBefore(brAfter);
  } else {
    range.setEnd(container, container.childNodes.length);
  }

  const text = range.toString().trim();
  return text || null;
}

/**
 * Filter text to only lines containing Japanese characters.
 * Strips separator lines (---, ===) and blank lines.
 * @param {string} text - Full email text
 * @returns {string} - Japanese-only lines joined by newlines
 */
export function filterJapaneseContent(text) {
  const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/;
  const separatorRegex = /^[\s\-=]{3,}$/;

  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (separatorRegex.test(trimmed)) return false;
      return japaneseRegex.test(trimmed);
    })
    .map(line => line.replace(/^[>\s]+/, ''))
    .filter(line => line.trim())
    .join('\n');
}

/**
 * Get all Gmail thread message containers with their filtered Japanese text.
 * Each entry has the message element and its Japanese-only text.
 * @returns {Array<{messageEl: HTMLElement, text: string}>}
 */
export function getGmailThreadMessages() {
  const containers = document.querySelectorAll('.adn.ads');
  const results = [];

  for (const container of containers) {
    const messageEl = container.querySelector('.a3s.aiL');
    if (!messageEl) continue;

    const fullText = extractGmailMessageText(messageEl);
    const japaneseText = filterJapaneseContent(fullText);
    if (japaneseText) {
      results.push({ messageEl, text: japaneseText });
    }
  }

  return results;
}

/**
 * Get all visible Gmail message body elements
 * @returns {NodeListOf<HTMLElement>}
 */
export function getGmailMessageBodies() {
  return document.querySelectorAll('.a3s.aiL');
}
