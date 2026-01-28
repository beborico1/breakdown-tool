// Track the last copied index for "Copy New" feature
let lastCopiedIndex = 0;

// Translation state keyed by container element
// Value: { originalText, translatedText, overlayEl }
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
    const messageEl = container.querySelector('.ygicle.VbkSUe');

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
  if (state?.overlayEl && state.overlayEl.parentNode) {
    state.overlayEl.remove();
  }
  container.classList.remove('caption-has-overlay');
  translationState.delete(container);
}

/**
 * Handle click on a caption to translate it
 * @param {Event} event
 */
async function handleCaptionClick(event) {
  const container = event.currentTarget;
  const messageEl = container.querySelector('.ygicle.VbkSUe');

  if (!messageEl) return;

  debugLog('CLICK', 'Container clicked, text:', messageEl.textContent?.trim().slice(0, 60));

  // If already translated, toggle off
  if (translationState.has(container)) {
    debugLog('TOGGLE-OFF', 'Removing translation overlay');
    removeOverlay(container);
    return;
  }

  const originalText = messageEl.textContent?.trim();
  if (!originalText) return;

  // Create overlay element
  const overlayEl = document.createElement('span');
  overlayEl.className = 'caption-translation-overlay loading';
  overlayEl.textContent = 'Translating...';

  // Hide original and show overlay
  container.classList.add('caption-has-overlay');
  container.appendChild(overlayEl);

  // Store state
  translationState.set(container, { originalText, translatedText: null, overlayEl });

  debugLog('TRANSLATE', 'Overlay inserted, starting translation');

  try {
    const translated = await translateWithGemini(originalText);

    // Check if user toggled off while translation was in flight
    if (!translationState.has(container)) {
      debugLog('TRANSLATE', 'User toggled off during translation, discarding result');
      return;
    }

    overlayEl.textContent = translated;
    overlayEl.classList.remove('loading');
    translationState.get(container).translatedText = translated;

    debugLog('TRANSLATE', 'Overlay updated with translation');
  } catch (error) {
    console.error('Translation error:', error);
    debugLog('TRANSLATE', 'Error:', error.message);

    // Check if user toggled off while translation was in flight
    if (!translationState.has(container)) return;

    overlayEl.textContent = `[Error: ${error.message}]`;
    overlayEl.classList.remove('loading');
    overlayEl.classList.add('error');

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

// Set up a MutationObserver to handle dynamically added captions
const observer = new MutationObserver((mutations) => {
  let addedCount = 0;
  let removedCount = 0;

  for (const mutation of mutations) {
    // Skip mutations on our own overlay elements
    if (mutation.target.classList?.contains('caption-translation-overlay')) continue;

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
    debugLog('MUTATION', `Batch: +${addedCount} / -${removedCount} nodes`);
  }

  // Clean up stale state: containers no longer in DOM
  for (const [container] of translationState) {
    if (!document.body.contains(container)) {
      debugLog('CLEANUP', 'Stale container detected, removing state');
      translationState.delete(container);
    }
  }

  // Repair: verify all translated containers still have their overlays
  for (const [container, state] of translationState) {
    if (state.overlayEl && !container.contains(state.overlayEl)) {
      debugLog('REPAIR', 'Overlay dislodged by Meet, re-inserting');
      container.appendChild(state.overlayEl);
      container.classList.add('caption-has-overlay');
    }
  }

  // Wire up any new containers
  setupCaptionClickHandlers();
});

// Start observing when the page loads
function initializeObserver() {
  observer.observe(document.body, {
    childList: true,
    subtree: true
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
