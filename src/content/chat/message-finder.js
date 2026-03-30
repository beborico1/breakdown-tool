import { debugLog } from '../core/debug.js';

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
 * Extract text from a Google Chat message element.
 * Strips hidden accessibility spans and quoted reply blocks so only
 * the actual reply text is returned.
 * @param {HTMLElement} messageEl - Message element
 * @returns {string} - Message text
 */
export function extractChatMessageText(messageEl) {
  // Clone to avoid modifying original
  const clone = messageEl.cloneNode(true);

  // Remove hidden spans (accessibility text like "Quoted", "End Quote")
  clone.querySelectorAll('span[style*="display: none"], span[style*="display:none"]').forEach(el => el.remove());

  // Remove quoted block container if present.
  // Google Chat quoted replies have hidden spans with "Quoted"/"End Quote" text.
  // After removing hidden spans above, detect the quoted container by looking for
  // a direct child that previously contained those markers. We use the original
  // element to find the quoted block, then remove the corresponding child from the clone.
  const hiddenSpans = messageEl.querySelectorAll('span[style*="display: none"], span[style*="display:none"]');
  for (const span of hiddenSpans) {
    const text = span.textContent?.trim().toLowerCase() || '';
    if (text === 'quoted' || text === 'end quote' || text.includes('end quote')) {
      // Walk up to direct child of messageEl
      let node = span;
      while (node.parentElement && node.parentElement !== messageEl) {
        node = node.parentElement;
      }
      if (node.parentElement === messageEl) {
        // Find the same child in the clone by index
        const children = Array.from(messageEl.children);
        const index = children.indexOf(node);
        if (index >= 0 && clone.children[index]) {
          clone.children[index].remove();
        }
        break;
      }
    }
  }

  return clone.textContent?.trim() || '';
}
