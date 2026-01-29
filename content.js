// Track the last copied index for "Copy New" feature
let lastCopiedIndex = 0;

// Translation state keyed by container element
// Value: { originalText, originalEl, translatedText, translatedEl, contentKey }
const translationState = new Map();

// Cache translations by content key (survives container replacement)
// Key: `${speaker}|${textHash}|${timeBucket}`
// Value: { translatedText, timestamp, speaker, originalText }
const translationCache = new Map();

// Track which content keys are currently displayed (user hasn't toggled off)
const activeContentKeys = new Set();

// Cache pruning interval (5 minutes)
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

// Debug infrastructure
const DEBUG = true;
function debugLog(label, ...args) {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[CaptionTranslator][${ts}] ${label}:`, ...args);
}

// Observer loop detection
let observerCallCount = 0;
let observerCallWindowStart = Date.now();
const OBSERVER_RATE_LIMIT = 50; // max calls per second before warning

// API call counter
let apiCallCount = 0;

/**
 * Simple hash function for text content
 * @param {string} text
 * @returns {number}
 */
function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash;
}

/**
 * Get time bucket (10-second windows) to differentiate duplicate phrases
 * @returns {number}
 */
function getTimeBucket() {
  return Math.floor(Date.now() / 10000);
}

/**
 * Generate a stable content key for caching translations
 * @param {string} speaker
 * @param {string} text
 * @param {number} timeBucket
 * @returns {string}
 */
function generateContentKey(speaker, text, timeBucket) {
  return `${speaker}|${hashText(text)}|${timeBucket}`;
}

/**
 * Find a cached translation for the given speaker and text
 * Searches recent time buckets to handle edge cases
 * @param {string} speaker
 * @param {string} text
 * @returns {{translatedText: string, contentKey: string}|null}
 */
function findCachedTranslation(speaker, text) {
  const currentBucket = getTimeBucket();
  // Check current and previous 2 buckets (30-second window)
  for (let offset = 0; offset <= 2; offset++) {
    const key = generateContentKey(speaker, text, currentBucket - offset);
    const cached = translationCache.get(key);
    if (cached && cached.translatedText) {
      return { translatedText: cached.translatedText, contentKey: key };
    }
  }
  return null;
}

/**
 * Prune old cache entries that are no longer active
 */
function pruneTranslationCache() {
  const now = Date.now();
  for (const [key, value] of translationCache) {
    // Keep if actively displayed or recent
    if (activeContentKeys.has(key)) continue;
    if (now - value.timestamp < CACHE_MAX_AGE_MS) continue;
    translationCache.delete(key);
    debugLog('CACHE-PRUNE', `Removed stale entry: ${key.slice(0, 50)}`);
  }
}

// Observer config (reusable for observe/reconnect)
const OBSERVER_CONFIG = {
  childList: true,
  subtree: true,
  characterData: true,
};

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

  apiCallCount++;
  const prompt = `Translate the following text to English. Only output the translation, nothing else. If the text is already in English, output it as-is.\n\nText: ${text}`;
  debugLog('API', `Call #${apiCallCount}`);
  debugLog('API', `INPUT (${text.length} chars):`, text);
  debugLog('API', `FULL PROMPT:`, prompt);

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
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
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

  debugLog('API', `OUTPUT (${translatedText.trim().length} chars):`, translatedText.trim());
  return translatedText.trim();
}

/**
 * Remove overlay and clean up translation state for a container
 * @param {HTMLElement} container
 */
function removeOverlay(container) {
  const state = translationState.get(container);
  if (state?.translatedEl && state.translatedEl.parentNode) {
    if (state.originalEl) {
      state.translatedEl.replaceWith(state.originalEl);
      debugLog('TOGGLE-OFF', 'Restored original element');
    } else {
      state.translatedEl.remove();
    }
  }
  // Clear from active keys so it won't auto-reapply
  if (state?.contentKey) {
    activeContentKeys.delete(state.contentKey);
    debugLog('TOGGLE-OFF', `Removed from active keys: ${state.contentKey.slice(0, 50)}`);
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

  // Get speaker name for content key
  const nameEl = container.querySelector('.NWpY1d');
  const speaker = nameEl?.textContent?.trim() || '(unknown)';

  // Check cache first
  const cached = findCachedTranslation(speaker, originalText);

  // Create translated element with same classes as the original
  const translatedEl = document.createElement('div');
  translatedEl.className = messageEl.className;
  translatedEl.setAttribute('data-translated', 'true');

  // Clone the original element before replacing it
  const originalEl = messageEl.cloneNode(true);

  // If cached, use it immediately; otherwise show loading
  if (cached) {
    translatedEl.textContent = cached.translatedText;
    debugLog('CACHE-HIT', `Using cached translation for: ${originalText.slice(0, 40)}`);
  } else {
    translatedEl.setAttribute('data-loading', 'true');
    translatedEl.textContent = 'Translating...';
  }

  // Atomically replace the original with our element
  messageEl.replaceWith(translatedEl);

  // Generate content key for new translations
  const contentKey = cached?.contentKey || generateContentKey(speaker, originalText, getTimeBucket());

  // Store state with clone of original element and content key
  translationState.set(container, {
    originalText,
    originalEl,
    translatedText: cached?.translatedText || null,
    translatedEl,
    contentKey
  });

  // Mark as active
  activeContentKeys.add(contentKey);

  // If cached, we're done
  if (cached) {
    debugLog('TRANSLATE', 'Applied cached translation');
    return;
  }

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

    const state = translationState.get(container);
    state.translatedText = translated;

    // Store in cache for persistence across container replacements
    translationCache.set(contentKey, {
      translatedText: translated,
      timestamp: Date.now(),
      speaker,
      originalText
    });
    debugLog('CACHE-SET', `Cached translation: ${contentKey.slice(0, 50)}`);

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
    const messageEl = container.querySelector('.ygicle.VbkSUe:not([data-translated])');
    const speaker = nameEl?.textContent?.trim() || '(unknown)';
    const originalText = messageEl?.textContent?.trim() || '';

    debugLog('SETUP', `New container: speaker="${speaker}", text="${originalText.slice(0, 40)}..."`);

    // Auto-apply cached translation if this content is actively displayed
    if (originalText && activeContentKeys.size > 0) {
      const cached = findCachedTranslation(speaker, originalText);
      if (cached && activeContentKeys.has(cached.contentKey)) {
        debugLog('AUTO-APPLY', `Re-applying translation to new container: ${originalText.slice(0, 40)}`);

        // Create translated element
        const translatedEl = document.createElement('div');
        translatedEl.className = messageEl.className;
        translatedEl.setAttribute('data-translated', 'true');
        translatedEl.textContent = cached.translatedText;

        // Clone original before replacing
        const originalEl = messageEl.cloneNode(true);

        // Replace original with translated
        messageEl.replaceWith(translatedEl);

        // Store state for the new container
        translationState.set(container, {
          originalText,
          originalEl,
          translatedText: cached.translatedText,
          translatedEl,
          contentKey: cached.contentKey
        });
      }
    }
  });
}

let lastMutationLogTime = 0;

// Set up a MutationObserver to handle dynamically added captions
const observer = new MutationObserver((mutations) => {
  // Rate-limit detection
  observerCallCount++;
  const now = Date.now();
  const elapsed = now - observerCallWindowStart;

  if (elapsed >= 1000) {
    if (observerCallCount > OBSERVER_RATE_LIMIT) {
      debugLog('LOOP-DETECT', `Observer fired ${observerCallCount} times in ${elapsed}ms — possible infinite loop!`);
    }
    observerCallCount = 0;
    observerCallWindowStart = now;
  }

  let addedCount = 0;
  let removedCount = 0;

  for (const mutation of mutations) {
    // Skip mutations on our own translated elements
    if (mutation.target.hasAttribute?.('data-translated')) continue;

    if (mutation.type === 'characterData') {
      debugLog('MUTATION-TYPE', `characterData on`, mutation.target.nodeName,
        'parent:', mutation.target.parentElement?.className?.slice(0, 40));
    }

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
  // Try to re-associate with new containers that have matching content
  for (const [container, state] of translationState) {
    if (!document.body.contains(container)) {
      debugLog('CLEANUP', 'Stale container detected, attempting re-association');

      // Try to find a new container with matching content
      let reassociated = false;
      if (state.contentKey && state.translatedText) {
        const allContainers = document.querySelectorAll('.nMcdL');
        for (const newContainer of allContainers) {
          // Skip if already has translation state
          if (translationState.has(newContainer)) continue;

          const nameEl = newContainer.querySelector('.NWpY1d');
          const messageEl = newContainer.querySelector('.ygicle.VbkSUe:not([data-translated])');
          const speaker = nameEl?.textContent?.trim() || '(unknown)';
          const text = messageEl?.textContent?.trim() || '';

          if (!text) continue;

          // Check if content matches
          const cached = findCachedTranslation(speaker, text);
          if (cached && cached.contentKey === state.contentKey) {
            debugLog('REASSOC', `Found matching container for: ${text.slice(0, 40)}`);

            // Create new translated element
            const translatedEl = document.createElement('div');
            translatedEl.className = messageEl.className;
            translatedEl.setAttribute('data-translated', 'true');
            translatedEl.textContent = state.translatedText;

            // Clone original before replacing
            const originalEl = messageEl.cloneNode(true);

            // Disconnect observer during our DOM modification
            observer.disconnect();

            // Replace original with translated
            messageEl.replaceWith(translatedEl);

            // Store state for the new container
            translationState.set(newContainer, {
              originalText: text,
              originalEl,
              translatedText: state.translatedText,
              translatedEl,
              contentKey: state.contentKey
            });

            // Mark new container as translatable
            newContainer.classList.add('caption-translatable');
            newContainer.addEventListener('click', handleCaptionClick);

            // Reconnect observer
            observer.observe(document.body, OBSERVER_CONFIG);

            reassociated = true;
            break;
          }
        }
      }

      if (!reassociated) {
        debugLog('CLEANUP', 'No matching container found, removing state');
      }

      // Always remove the stale container entry
      translationState.delete(container);
    }
  }

  // Fight Meet re-insertions: protect translated containers
  // Disconnect observer lazily to prevent infinite loop from our own DOM modifications
  let didFight = false;

  for (const [container, state] of translationState) {
    // (A) Remove any original caption elements Meet re-inserted
    const originals = container.querySelectorAll('.ygicle.VbkSUe:not([data-translated])');
    if (originals.length > 0) {
      if (!didFight) { observer.disconnect(); didFight = true; }
      // debugLog('FIGHT-A', `Removing ${originals.length} re-inserted original(s)`);
      for (const orig of originals) {
        orig.remove();
      }
    }

    // (B) Re-insert our element if dislodged
    if (state.translatedEl && !container.contains(state.translatedEl)) {
      if (!didFight) { observer.disconnect(); didFight = true; }
      // debugLog('FIGHT-B', 'Re-inserting dislodged translated element');
      container.appendChild(state.translatedEl);
    }

    // (C) Restore text if Meet overwrote it
    if (state.translatedText && state.translatedEl &&
        state.translatedEl.textContent !== state.translatedText) {
      if (!didFight) { observer.disconnect(); didFight = true; }
      // debugLog('FIGHT-C', `Text mismatch — has: "${state.translatedEl.textContent?.slice(0, 40)}", want: "${state.translatedText?.slice(0, 40)}"`);
      state.translatedEl.textContent = state.translatedText;
    }
  }

  // Reconnect observer after our DOM modifications are done
  if (didFight) {
    observer.observe(document.body, OBSERVER_CONFIG);
  }

  // Wire up any new containers
  setupCaptionClickHandlers();
});

// Start observing when the page loads
function initializeObserver() {
  observer.observe(document.body, OBSERVER_CONFIG);
  // Initial setup
  setupCaptionClickHandlers();

  // Prune translation cache periodically (every minute)
  setInterval(pruneTranslationCache, 60 * 1000);

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
