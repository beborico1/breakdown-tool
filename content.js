// Track the last copied index for "Copy New" feature
let lastCopiedIndex = 0;

// Translation state keyed by container element
// Value: { originalText, translatedText, translatedEl }
const translationState = new Map();

// Debug infrastructure
const DEBUG = true;
function debugLog(label, ...args) {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[CaptionTranslator][${ts}] ${label}:`, ...args);
}

/**
 * Extract all captions from the page
 * @returns {Array<{name: string, message: string}>}
 */
function extractCaptions() {
  const captions = [];
  const containers = document.querySelectorAll('.nMcdL');

  containers.forEach(container => {
    const nameEl = container.querySelector('.NWpY1d');
    const messageEl = container.querySelector('.ygicle.VbkSUe[data-translated]')
                   || container.querySelector('.ygicle.VbkSUe');

    const name = nameEl?.textContent?.trim() || '';
    const message = messageEl?.textContent?.trim() || '';

    // Skip entries with empty messages
    if (message) {
      captions.push({ name, message });
    }
  });

  return captions;
}

/**
 * Format captions as "Name: Message" strings
 * @param {Array<{name: string, message: string}>} captions
 * @returns {string}
 */
function formatCaptions(captions) {
  return captions
    .map(({ name, message }) => `${name}: ${message}`)
    .join('\n');
}

/**
 * Get the Gemini API key from storage
 * @returns {Promise<string|null>}
 */
async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['geminiApiKey'], (result) => {
      resolve(result.geminiApiKey || null);
    });
  });
}

/**
 * Translate text using Gemini 2.5 Flash
 * @param {string} text - Text to translate
 * @returns {Promise<string>} - Translated text
 */
async function translateWithGemini(text) {
  const apiKey = await getApiKey();

  if (!apiKey) {
    throw new Error('No API key. Set it in the extension popup.');
  }

  debugLog('API', 'Requesting translation for:', text.slice(0, 80));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Translate the following text to English. Only output the translation, nothing else. If the text is already in English, output it as-is.\n\nText: ${text}`
          }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json();
    debugLog('API', 'Error response:', error);
    throw new Error(error.error?.message || 'Translation failed');
  }

  const data = await response.json();
  const translatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!translatedText) {
    debugLog('API', 'No translation in response:', data);
    throw new Error('No translation returned');
  }

  debugLog('API', 'Translation received:', translatedText.trim().slice(0, 80));
  return translatedText.trim();
}

/**
 * Remove overlay and clean up translation state for a container
 * @param {HTMLElement} container
 */
function removeOverlay(container) {
  const state = translationState.get(container);
  if (state?.translatedEl && state.translatedEl.parentNode) {
    state.translatedEl.remove();
  }
  translationState.delete(container);
}

/**
 * Handle click on a caption to translate it
 * @param {Event} event
 */
async function handleCaptionClick(event) {
  const container = event.currentTarget;

  // If already translated, toggle off
  if (translationState.has(container)) {
    debugLog('TOGGLE-OFF', 'Removing translation overlay');
    removeOverlay(container);
    return;
  }

  // Find the original (non-translated) caption element
  const messageEl = container.querySelector('.ygicle.VbkSUe:not([data-translated])');
  if (!messageEl) return;

  debugLog('CLICK', 'Container clicked, text:', messageEl.textContent?.trim().slice(0, 60));

  const originalText = messageEl.textContent?.trim();
  if (!originalText) return;

  // Create translated element with same classes as the original
  const translatedEl = document.createElement('div');
  translatedEl.className = messageEl.className;
  translatedEl.setAttribute('data-translated', 'true');
  translatedEl.setAttribute('data-loading', 'true');
  translatedEl.textContent = 'Translating...';

  // Atomically replace the original with our element
  messageEl.replaceWith(translatedEl);

  // Store state
  translationState.set(container, { originalText, translatedText: null, translatedEl });

  debugLog('TRANSLATE', 'Original replaced with translated element, starting translation');

  try {
    const translated = await translateWithGemini(originalText);

    // Check if user toggled off while translation was in flight
    if (!translationState.has(container)) {
      debugLog('TRANSLATE', 'User toggled off during translation, discarding result');
      return;
    }

    translatedEl.textContent = translated;
    translatedEl.removeAttribute('data-loading');
    translationState.get(container).translatedText = translated;

    debugLog('TRANSLATE', 'Translated element updated with translation');
  } catch (error) {
    console.error('Translation error:', error);
    debugLog('TRANSLATE', 'Error:', error.message);

    // Check if user toggled off while translation was in flight
    if (!translationState.has(container)) return;

    translatedEl.textContent = `[Error: ${error.message}]`;
    translatedEl.removeAttribute('data-loading');
    translatedEl.setAttribute('data-error', 'true');

    // Clean up after 3 seconds to allow retry
    setTimeout(() => {
      if (translationState.has(container)) {
        removeOverlay(container);
      }
    }, 3000);
  }
}

/**
 * Make caption containers clickable for translation
 */
function setupCaptionClickHandlers() {
  const containers = document.querySelectorAll('.nMcdL:not(.caption-translatable)');

  containers.forEach(container => {
    container.classList.add('caption-translatable');
    container.addEventListener('click', handleCaptionClick);

    const nameEl = container.querySelector('.NWpY1d');
    const messageEl = container.querySelector('.ygicle.VbkSUe');
    const speaker = nameEl?.textContent?.trim() || '(unknown)';
    const snippet = messageEl?.textContent?.trim().slice(0, 40) || '';

    debugLog('SETUP', `New container: speaker="${speaker}", text="${snippet}..."`);
  });
}

let lastMutationLogTime = 0;

// Set up a MutationObserver to handle dynamically added captions
const observer = new MutationObserver((mutations) => {
  let addedCount = 0;
  let removedCount = 0;

  for (const mutation of mutations) {
    // Skip mutations on our own translated elements
    if (mutation.target.hasAttribute?.('data-translated')) continue;

    addedCount += mutation.addedNodes.length;
    removedCount += mutation.removedNodes.length;

    // Check if any removed nodes contain translated containers
    for (const node of mutation.removedNodes) {
      if (!(node instanceof HTMLElement)) continue;

      // Check if the removed node itself is a translated container
      if (node.classList?.contains('nMcdL') && translationState.has(node)) {
        debugLog('MUTATION-REMOVED', 'Translated container removed from DOM');
        translationState.delete(node);
      }

      // Check for translated containers inside the removed subtree
      const inner = node.querySelectorAll?.('.nMcdL');
      if (inner) {
        for (const el of inner) {
          if (translationState.has(el)) {
            debugLog('MUTATION-REMOVED', 'Translated container removed (nested)');
            translationState.delete(el);
          }
        }
      }
    }
  }

  if (addedCount > 0 || removedCount > 0) {
    const now = Date.now();
    if (now - lastMutationLogTime > 1000) {
      debugLog('MUTATION', `Batch: +${addedCount} / -${removedCount} nodes`);
      lastMutationLogTime = now;
    }
  }

  // Clean up stale state: containers no longer in DOM
  for (const [container] of translationState) {
    if (!document.body.contains(container)) {
      debugLog('CLEANUP', 'Stale container detected, removing state');
      translationState.delete(container);
    }
  }

  // Fight Meet re-insertions: protect translated containers
  for (const [container, state] of translationState) {
    // (A) Remove any original caption elements Meet re-inserted
    const originals = container.querySelectorAll('.ygicle.VbkSUe:not([data-translated])');
    for (const orig of originals) {
      orig.remove();
    }

    // (B) Re-insert our element if dislodged
    if (state.translatedEl && !container.contains(state.translatedEl)) {
      container.appendChild(state.translatedEl);
    }

    // (C) Restore text if Meet overwrote it
    if (state.translatedText && state.translatedEl &&
        state.translatedEl.textContent !== state.translatedText) {
      state.translatedEl.textContent = state.translatedText;
    }
  }

  // Wire up any new containers
  setupCaptionClickHandlers();
});

// Start observing when the page loads
function initializeObserver() {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
  // Initial setup
  setupCaptionClickHandlers();
  debugLog('SETUP', 'Observer initialized');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeObserver);
} else {
  initializeObserver();
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'copyAll') {
    const captions = extractCaptions();

    if (captions.length === 0) {
      sendResponse({ success: false, message: 'No captions found', text: null });
      return;
    }

    const formatted = formatCaptions(captions);
    lastCopiedIndex = captions.length;
    sendResponse({
      success: true,
      message: `Copied ${captions.length} caption(s)`,
      text: formatted
    });
    return;
  }

  if (request.action === 'copyNew') {
    const captions = extractCaptions();
    const newCaptions = captions.slice(lastCopiedIndex);

    if (newCaptions.length === 0) {
      sendResponse({ success: false, message: 'No new captions since last copy', text: null });
      return;
    }

    const formatted = formatCaptions(newCaptions);
    lastCopiedIndex = captions.length;
    sendResponse({
      success: true,
      message: `Copied ${newCaptions.length} new caption(s)`,
      text: formatted
    });
    return;
  }
});
