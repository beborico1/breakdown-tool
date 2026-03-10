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

  // Target is inside a message body
  let messageEl = target.closest('.a3s.aiL');
  if (messageEl) {
    debugLog('GMAIL-FIND', 'Found via closest .a3s.aiL');
    return messageEl;
  }

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

  return clone.textContent?.trim() || '';
}

/**
 * Get all visible Gmail message body elements
 * @returns {NodeListOf<HTMLElement>}
 */
export function getGmailMessageBodies() {
  return document.querySelectorAll('.a3s.aiL');
}
