// Track the last copied index for "Copy New" feature
let lastCopiedIndex = 0;

// Translation state keyed by container element
// Value: { originalText, originalEl, translatedText, translatedEl, contentKey,
//          lastTranslatedLength, shadowOriginalEl, speakerName, isIncremental,
//          breakdownData, isExpanded }
const translationState = new Map();

// Delta translation debouncing
const DELTA_DEBOUNCE_MS = 500;
const pendingDeltas = new Map();

// Cache translations by content key (survives container replacement)
// Key: `${speaker}|${textHash}|${timeBucket}`
// Value: { translatedText, breakdownData, timestamp, speaker, originalText }
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
 * Analyze Japanese text with Gemini and return structured breakdown
 * @param {string} text - Japanese text to analyze
 * @returns {Promise<{original: string, translation: string, words: Array<{japanese: string, reading: string, romaji: string, english: string, type: string}>}>}
 */
async function analyzeJapaneseWithGemini(text) {
  const apiKey = await getApiKey();

  if (!apiKey) {
    throw new Error('No API key. Set it in the extension popup.');
  }

  apiCallCount++;

  const prompt = `Analyze this Japanese text and return ONLY valid JSON (no markdown, no code blocks, no explanation):
{
  "original": "the original Japanese text exactly as provided",
  "translation": "natural English translation of the full sentence",
  "words": [
    {
      "japanese": "word in kanji/kana as it appears",
      "reading": "hiragana reading (only for words with kanji, empty string for hiragana/katakana-only words)",
      "romaji": "romanized pronunciation",
      "english": "English meaning or grammatical function",
      "type": "noun|verb|particle|adjective|adverb|counter|expression|auxiliary|copula"
    }
  ]
}

Important:
- Break down ALL words including particles (は, が, を, に, etc.)
- For particles, use their grammatical function as english (e.g., "topic marker", "subject marker", "object marker")
- Keep word order matching the original sentence
- Use lowercase for romaji except for proper nouns
- For verbs, include the conjugated form as it appears

Text: ${text}`;

  debugLog('API-BREAKDOWN', `Call #${apiCallCount}`);
  debugLog('API-BREAKDOWN', `INPUT (${text.length} chars):`, text);

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
          maxOutputTokens: 65536,
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json();
    debugLog('API-BREAKDOWN', 'Error response:', error);
    throw new Error(error.error?.message || 'Analysis failed');
  }

  const data = await response.json();
  let responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!responseText) {
    debugLog('API-BREAKDOWN', 'No response text:', data);
    throw new Error('No analysis returned');
  }

  // Clean up potential markdown code blocks
  responseText = responseText.trim();
  if (responseText.startsWith('```json')) {
    responseText = responseText.slice(7);
  } else if (responseText.startsWith('```')) {
    responseText = responseText.slice(3);
  }
  if (responseText.endsWith('```')) {
    responseText = responseText.slice(0, -3);
  }
  responseText = responseText.trim();

  try {
    const breakdown = JSON.parse(responseText);

    // Validate structure
    if (!breakdown.original || !breakdown.translation || !Array.isArray(breakdown.words)) {
      throw new Error('Invalid breakdown structure');
    }

    debugLog('API-BREAKDOWN', `OUTPUT: ${breakdown.words.length} words parsed`);
    return breakdown;
  } catch (parseError) {
    debugLog('API-BREAKDOWN', 'JSON parse error:', parseError.message);
    debugLog('API-BREAKDOWN', 'Raw response:', responseText.slice(0, 200));
    throw new Error('Failed to parse breakdown response');
  }
}

/**
 * Get CSS class suffix for word type
 * @param {string} type - Word type from breakdown
 * @returns {string} - CSS class suffix
 */
function getWordTypeClass(type) {
  const typeMap = {
    'noun': 'noun',
    'verb': 'verb',
    'particle': 'particle',
    'adjective': 'adjective',
    'adverb': 'adverb',
    'counter': 'counter',
    'expression': 'expression',
    'auxiliary': 'auxiliary',
    'copula': 'copula'
  };
  return typeMap[type?.toLowerCase()] || 'other';
}

/**
 * Build ruby HTML for a word with furigana
 * @param {string} japanese - Japanese word
 * @param {string} reading - Hiragana reading (empty if no kanji)
 * @returns {string} - HTML string with ruby if needed
 */
function buildRubyHtml(japanese, reading) {
  if (!reading || reading === japanese) {
    // No furigana needed (already hiragana/katakana or reading matches)
    return `<span class="word-segment">${japanese}</span>`;
  }
  return `<ruby class="word-segment">${japanese}<rt>${reading}</rt></ruby>`;
}

/**
 * Render the breakdown panel for a caption
 * @param {HTMLElement} container - Caption container element
 * @param {Object} breakdownData - Breakdown data from API
 * @param {string} speakerName - Speaker name
 * @param {boolean} isExpanded - Whether panel should be expanded (default: true)
 */
function renderBreakdownPanel(container, breakdownData, speakerName, isExpanded = true) {
  // Remove any existing breakdown panel
  const existingPanel = container.querySelector('.breakdown-panel');
  if (existingPanel) {
    existingPanel.remove();
  }

  const panel = document.createElement('div');
  panel.className = 'breakdown-panel';
  panel.setAttribute('data-expanded', isExpanded ? 'true' : 'false');

  // Speaker header (commented out - already shown on parent card)
  // const header = document.createElement('div');
  // header.className = 'breakdown-header';
  // header.innerHTML = `<span class="breakdown-speaker">${speakerName}</span>`;
  // panel.appendChild(header);

  // Original sentence with furigana
  const originalDiv = document.createElement('div');
  originalDiv.className = 'breakdown-original';
  const furiganaHtml = breakdownData.words
    .map(w => buildRubyHtml(w.japanese, w.reading))
    .join('');
  originalDiv.innerHTML = `「${furiganaHtml}」`;
  panel.appendChild(originalDiv);

  // Pending text element (for incoming unprocessed text)
  const pendingDiv = document.createElement('div');
  pendingDiv.className = 'breakdown-pending';
  pendingDiv.style.display = 'none'; // Hidden until there's new text
  panel.appendChild(pendingDiv);

  // Word breakdown grid
  const grid = document.createElement('div');
  grid.className = 'breakdown-grid';

  // Table header
  const headerRow = document.createElement('div');
  headerRow.className = 'breakdown-grid-header';
  headerRow.innerHTML = `
    <span class="grid-col">JAPANESE</span>
    <span class="grid-col">ROMAJI</span>
    <span class="grid-col">ENGLISH</span>
  `;
  grid.appendChild(headerRow);

  // Word rows
  breakdownData.words.forEach(word => {
    const row = document.createElement('div');
    row.className = 'breakdown-word-row';
    const typeClass = getWordTypeClass(word.type);
    row.innerHTML = `
      <span class="word-japanese type-${typeClass}">${word.japanese}</span>
      <span class="word-romaji">${word.romaji}</span>
      <span class="word-english">${word.english}</span>
    `;
    grid.appendChild(row);
  });

  panel.appendChild(grid);

  // Full translation
  const translationDiv = document.createElement('div');
  translationDiv.className = 'breakdown-translation';
  translationDiv.textContent = `"${breakdownData.translation}"`;
  panel.appendChild(translationDiv);

  // Insert panel into container
  container.appendChild(panel);

  // debugLog('BREAKDOWN', 'Panel rendered with', breakdownData.words.length, 'words');
}

/**
 * Reprocess breakdown panel with updated text
 * @param {HTMLElement} container - Caption container
 * @param {string} text - Full text to analyze
 * @param {string} speakerName - Speaker name
 */
async function reprocessBreakdown(container, text, speakerName) {
  const state = translationState.get(container);
  if (!state) return;

  try {
    const breakdownData = await analyzeJapaneseWithGemini(text);

    // Check if user toggled off while analysis was in flight
    if (!translationState.has(container)) {
      debugLog('REPROCESS', 'User toggled off during reanalysis, discarding result');
      return;
    }

    // Hide the loading placeholder
    state.translatedEl.style.display = 'none';
    state.translatedEl.removeAttribute('data-loading');

    // Update state with new breakdown data
    state.breakdownData = breakdownData;
    state.translatedText = breakdownData.translation;
    state.lastTranslatedLength = text.length;

    // Render the updated breakdown panel
    renderBreakdownPanel(container, breakdownData, speakerName, state.isExpanded);

    // Update cache
    if (state.contentKey) {
      const cacheEntry = translationCache.get(state.contentKey);
      if (cacheEntry) {
        cacheEntry.translatedText = breakdownData.translation;
        cacheEntry.breakdownData = breakdownData;
        cacheEntry.originalText = text;
        cacheEntry.timestamp = Date.now();
      }
    }

    debugLog('REPROCESS', 'Breakdown panel updated with new analysis');
  } catch (error) {
    console.error('Reprocess error:', error);
    debugLog('REPROCESS', 'Error:', error.message);

    // Check if user toggled off
    if (!translationState.has(container)) return;

    state.translatedEl.textContent = `[Error: ${error.message}]`;
    state.translatedEl.style.display = '';
    state.translatedEl.removeAttribute('data-loading');
    state.translatedEl.setAttribute('data-error', 'true');
  }
}

/**
 * Toggle breakdown panel expand/collapse
 * @param {HTMLElement} container - Caption container
 */
function toggleBreakdownPanel(container) {
  const panel = container.querySelector('.breakdown-panel');
  if (!panel) return;

  const state = translationState.get(container);
  const isExpanded = panel.getAttribute('data-expanded') === 'true';
  const newExpandedState = !isExpanded;

  panel.setAttribute('data-expanded', newExpandedState);

  // Sync state for persistence across re-renders
  if (state) {
    state.isExpanded = newExpandedState;
  }

  const collapseBtn = panel.querySelector('[data-action="collapse"]');
  if (collapseBtn) {
    collapseBtn.textContent = newExpandedState ? '▲' : '▼';
  }

  debugLog('BREAKDOWN', `Panel ${newExpandedState ? 'expanded' : 'collapsed'}`);
}

/**
 * Handle copy action from breakdown panel
 * @param {string} action - Copy action type (japanese, romaji, translation)
 * @param {Object} breakdownData - Breakdown data
 * @param {HTMLElement} button - Button element for feedback
 */
function handleCopyAction(action, breakdownData, button) {
  let text;
  switch (action) {
    case 'japanese':
      text = breakdownData.original;
      break;
    case 'romaji':
      text = breakdownData.words.map(w => w.romaji).join(' ');
      break;
    case 'translation':
      text = breakdownData.translation;
      break;
    default:
      return;
  }

  navigator.clipboard.writeText(text).then(() => {
    // Show brief feedback
    const originalText = button.textContent;
    button.textContent = 'Copied!';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 1500);

    debugLog('COPY', `Copied ${action}:`, text.slice(0, 50));
  }).catch(err => {
    debugLog('COPY', 'Failed:', err.message);
  });
}

/**
 * Translate text using Gemini 2.5 Flash
 * @param {string} text - Text to translate
 * @param {Object} options - Translation options
 * @param {string} options.previousTranslation - Previous translation for context (delta mode)
 * @param {boolean} options.isDelta - Whether this is a delta translation
 * @returns {Promise<string>} - Translated text
 */
async function translateWithGemini(text, options = {}) {
  const apiKey = await getApiKey();

  if (!apiKey) {
    throw new Error('No API key. Set it in the extension popup.');
  }

  apiCallCount++;

  let prompt;
  if (options.isDelta && options.previousTranslation) {
    // Context-aware delta translation
    const contextSnippet = options.previousTranslation.slice(-50);
    prompt = `Continue this translation. Previous translation ended with: "${contextSnippet}"\n\nTranslate this continuation to English. Only output the translation of the new text, nothing else:\n\n${text}`;
  } else {
    prompt = `Translate the following text to English. Only output the translation, nothing else. If the text is already in English, output it as-is.\n\nText: ${text}`;
  }

  debugLog('API', `Call #${apiCallCount}${options.isDelta ? ' (DELTA)' : ''}`);
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
          maxOutputTokens: 65536,
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
 * Classify text change to determine translation strategy
 * @param {string} oldText - Previously translated text
 * @param {string} newText - New text from shadow element
 * @returns {{type: 'append'|'correction'|'full', delta?: string, newText?: string}}
 */
function classifyTextChange(oldText, newText) {
  // Check for simple append (most common case for live captions)
  if (newText.startsWith(oldText)) {
    const delta = newText.slice(oldText.length);
    if (delta.length > 0) {
      return { type: 'append', delta };
    }
    return { type: 'none' };
  }

  // Find common prefix length for corrections
  let i = 0;
  while (i < oldText.length && i < newText.length && oldText[i] === newText[i]) {
    i++;
  }

  // If more than 80% of old text is preserved, treat as correction
  if (oldText.length > 0 && i / oldText.length > 0.8) {
    return { type: 'correction', newText, commonPrefixLength: i };
  }

  // Full re-translation needed
  return { type: 'full', newText };
}

/**
 * Hide the original element and mark it as shadow
 * @param {HTMLElement} originalEl
 */
function hideOriginalElement(originalEl) {
  originalEl.style.cssText = 'position:absolute;opacity:0;pointer-events:none;height:0;overflow:hidden';
  originalEl.setAttribute('data-shadow-original', 'true');
}

/**
 * Queue a delta translation with debouncing
 * @param {HTMLElement} container
 * @param {string} delta - New text to translate
 * @param {string} fullNewText - Complete new text
 */
function queueDeltaTranslation(container, delta, fullNewText) {
  // Clear any pending delta for this container
  const existingTimeout = pendingDeltas.get(container);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // Mark as updating
  const state = translationState.get(container);
  if (state?.translatedEl) {
    state.translatedEl.setAttribute('data-updating', 'true');
  }

  const timeoutId = setTimeout(async () => {
    pendingDeltas.delete(container);
    await executeDeltaTranslation(container, delta, fullNewText);
  }, DELTA_DEBOUNCE_MS);

  pendingDeltas.set(container, timeoutId);
  debugLog('DELTA-QUEUE', `Queued delta translation: "${delta.slice(0, 30)}..."`);
}

/**
 * Execute a delta translation
 * @param {HTMLElement} container
 * @param {string} delta - Text to translate
 * @param {string} fullNewText - Complete original text
 */
async function executeDeltaTranslation(container, delta, fullNewText) {
  const state = translationState.get(container);
  if (!state) {
    debugLog('DELTA-EXEC', 'State no longer exists, skipping');
    return;
  }

  debugLog('DELTA-EXEC', `Translating delta: "${delta.slice(0, 40)}..."`);

  try {
    const translatedDelta = await translateWithGemini(delta, {
      isDelta: true,
      previousTranslation: state.translatedText
    });

    // Check if state still exists (user may have toggled off)
    if (!translationState.has(container)) {
      debugLog('DELTA-EXEC', 'Container toggled off during translation');
      return;
    }

    // Append translated delta to existing translation
    const newTranslatedText = state.translatedText + ' ' + translatedDelta;
    state.translatedText = newTranslatedText;
    state.translatedEl.textContent = newTranslatedText;
    state.translatedEl.removeAttribute('data-updating');
    state.translatedEl.removeAttribute('data-has-delta');

    // Update tracking
    state.originalText = fullNewText;
    state.lastTranslatedLength = fullNewText.length;

    // Update cache
    if (state.contentKey) {
      const cacheEntry = translationCache.get(state.contentKey);
      if (cacheEntry) {
        cacheEntry.translatedText = newTranslatedText;
        cacheEntry.originalText = fullNewText;
        cacheEntry.timestamp = Date.now();
      }
    }

    debugLog('DELTA-EXEC', `Updated translation: "${newTranslatedText.slice(-60)}..."`);
  } catch (error) {
    debugLog('DELTA-EXEC', 'Delta translation failed:', error.message);
    state.translatedEl?.removeAttribute('data-updating');
  }
}

/**
 * Handle text updates from shadow original elements
 * @param {HTMLElement} container
 * @param {string} newText
 */
function handleTextUpdate(container, newText) {
  const state = translationState.get(container);
  if (!state || !state.isIncremental) return;

  const oldText = state.originalText;
  if (newText === oldText) return; // No change

  debugLog('TEXT-UPDATE', `Old: "${oldText.slice(-30)}" -> New: "${newText.slice(-30)}"`);

  const change = classifyTextChange(oldText, newText);
  debugLog('TEXT-UPDATE', `Change type: ${change.type}`);

  switch (change.type) {
    case 'none':
      // No meaningful change
      break;

    case 'append':
      // Queue delta translation
      queueDeltaTranslation(container, change.delta, newText);
      break;

    case 'correction':
      // For corrections, we could be smarter but for now re-translate from correction point
      // This is a simplification - a more sophisticated approach would re-translate only the changed part
      debugLog('TEXT-UPDATE', 'Correction detected, re-translating changed portion');
      queueDeltaTranslation(container, newText.slice(change.commonPrefixLength), newText);
      break;

    case 'full':
      // Full re-translation needed (rare case)
      debugLog('TEXT-UPDATE', 'Full re-translation needed');
      // Cancel any pending delta
      const pendingTimeout = pendingDeltas.get(container);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDeltas.delete(container);
      }
      // Trigger full re-translation by updating state and calling translate
      state.originalText = newText;
      state.lastTranslatedLength = 0;
      executeFullRetranslation(container, newText);
      break;
  }
}

/**
 * Execute a full re-translation (for major text changes)
 * @param {HTMLElement} container
 * @param {string} text
 */
async function executeFullRetranslation(container, text) {
  const state = translationState.get(container);
  if (!state) return;

  state.translatedEl?.setAttribute('data-updating', 'true');

  try {
    const translated = await translateWithGemini(text);

    if (!translationState.has(container)) return;

    state.translatedText = translated;
    state.translatedEl.textContent = translated;
    state.translatedEl.removeAttribute('data-updating');
    state.originalText = text;
    state.lastTranslatedLength = text.length;

    // Update cache
    if (state.contentKey) {
      const cacheEntry = translationCache.get(state.contentKey);
      if (cacheEntry) {
        cacheEntry.translatedText = translated;
        cacheEntry.originalText = text;
        cacheEntry.timestamp = Date.now();
      }
    }

    debugLog('FULL-RETRANS', 'Completed full re-translation');
  } catch (error) {
    debugLog('FULL-RETRANS', 'Failed:', error.message);
    state.translatedEl?.removeAttribute('data-updating');
  }
}

/**
 * Update breakdown panel with incoming unprocessed text
 * Shows new Japanese text below the furigana line without auto-processing
 * @param {HTMLElement} container
 */
function updateBreakdownDelta(container) {
  const state = translationState.get(container);
  if (!state?.shadowOriginalEl || !state.breakdownData) return;

  const currentText = state.shadowOriginalEl.textContent?.trim() || '';
  const processedText = state.originalText;

  if (currentText.length > processedText.length && currentText.startsWith(processedText)) {
    const newText = currentText.slice(processedText.length);
    const pendingDiv = container.querySelector('.breakdown-pending');
    if (pendingDiv) {
      pendingDiv.textContent = newText;
      pendingDiv.style.display = 'block';
      debugLog('BREAKDOWN-DELTA', `Showing pending text: "${newText.slice(0, 40)}..."`);
    }
  }
}

/**
 * Update visual display with untranslated delta text (no API call)
 * Shows: [already translated text] [new untranslated original text]
 * @param {HTMLElement} container
 */
function updateVisualDelta(container) {
  const state = translationState.get(container);
  if (!state?.shadowOriginalEl || !state.isIncremental) return;

  const currentText = state.shadowOriginalEl.textContent?.trim() || '';
  const translatedPortion = state.originalText; // What we've already translated

  // Only show delta if new text is appended to what we've translated
  if (currentText.length > translatedPortion.length && currentText.startsWith(translatedPortion)) {
    const untranslatedDelta = currentText.slice(translatedPortion.length);
    // Show: translated + untranslated original (mixed display)
    state.translatedEl.textContent = state.translatedText + ' ' + untranslatedDelta;
    state.translatedEl.setAttribute('data-has-delta', 'true');
    debugLog('VISUAL-DELTA', `Showing untranslated delta: "${untranslatedDelta.slice(0, 40)}..."`);
  }
}

/**
 * Remove overlay and clean up translation state for a container
 * @param {HTMLElement} container
 */
function removeOverlay(container) {
  const state = translationState.get(container);

  // Cancel any pending delta translation
  const pendingTimeout = pendingDeltas.get(container);
  if (pendingTimeout) {
    clearTimeout(pendingTimeout);
    pendingDeltas.delete(container);
  }

  // Remove breakdown panel if present
  const breakdownPanel = container.querySelector('.breakdown-panel');
  if (breakdownPanel) {
    breakdownPanel.remove();
  }

  if (state?.translatedEl && state.translatedEl.parentNode) {
    // Handle shadow original element (incremental mode)
    if (state.shadowOriginalEl && state.shadowOriginalEl.parentNode) {
      // Restore shadow original to visible state
      state.shadowOriginalEl.style.cssText = '';
      state.shadowOriginalEl.removeAttribute('data-shadow-original');
      // Remove translated element
      state.translatedEl.remove();
      debugLog('TOGGLE-OFF', 'Restored shadow original element');
    } else if (state.originalEl) {
      // Legacy mode: replace translated with clone
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

  // Check if click was on a breakdown panel button (let it handle itself)
  if (event.target.closest('.breakdown-actions')) {
    return;
  }

  // If already has breakdown, toggle expand/collapse
  if (translationState.has(container)) {
    const state = translationState.get(container);

    // If breakdown panel exists, check for new text or toggle
    if (state.breakdownData) {
      const currentText = state.shadowOriginalEl?.textContent?.trim() || '';

      // If there's new text, reprocess the entire message
      if (currentText.length > state.originalText.length && currentText.startsWith(state.originalText)) {
        debugLog('REPROCESS', `New text detected, reprocessing full message`);
        // Update state and trigger reanalysis
        state.originalText = currentText;
        state.breakdownData = null; // Clear old breakdown
        // Remove old panel and show loading
        const panel = container.querySelector('.breakdown-panel');
        if (panel) panel.remove();
        // Show loading indicator
        state.translatedEl.style.display = '';
        state.translatedEl.setAttribute('data-loading', 'true');
        state.translatedEl.textContent = 'Reanalyzing...';
        // Trigger new analysis
        reprocessBreakdown(container, currentText, state.speakerName);
        return;
      }

      // Otherwise toggle expand/collapse as before
      const panel = container.querySelector('.breakdown-panel');
      if (panel) {
        toggleBreakdownPanel(container);
        return;
      }
    }

    // Check if shadow element has new text (delta available) - for legacy mode
    if (state.shadowOriginalEl && state.isIncremental && !state.breakdownData) {
      const currentText = state.shadowOriginalEl.textContent?.trim() || '';
      if (currentText.length > state.originalText.length && currentText.startsWith(state.originalText)) {
        // New text appended - translate delta instead of toggling off
        const delta = currentText.slice(state.originalText.length);
        debugLog('CLICK-DELTA', `Found new text, translating delta: "${delta.slice(0, 40)}..."`);
        queueDeltaTranslation(container, delta, currentText);
        return;
      }
    }

    // No new text - toggle off (remove overlay)
    debugLog('TOGGLE-OFF', 'Removing translation overlay');
    removeOverlay(container);
    return;
  }

  // Find the original (non-translated, non-shadow) caption element
  const messageEl = container.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original])');
  if (!messageEl) return;

  debugLog('CLICK', 'Container clicked, text:', messageEl.textContent?.trim().slice(0, 60));

  const originalText = messageEl.textContent?.trim();
  if (!originalText) return;

  // Get speaker name for content key
  const nameEl = container.querySelector('.NWpY1d');
  const speaker = nameEl?.textContent?.trim() || '(unknown)';

  // Check cache first (now caches breakdown data)
  const cached = findCachedTranslation(speaker, originalText);

  // Create a placeholder element while loading
  const translatedEl = document.createElement('div');
  translatedEl.className = messageEl.className;
  translatedEl.setAttribute('data-translated', 'true');

  // If cached with breakdown data, render immediately
  if (cached?.breakdownData) {
    translatedEl.style.display = 'none'; // Hide the placeholder
    debugLog('CACHE-HIT', `Using cached breakdown for: ${originalText.slice(0, 40)}`);
  } else {
    translatedEl.setAttribute('data-loading', 'true');
    translatedEl.textContent = 'Analyzing Japanese...';
  }

  // Shadow element strategy: hide original instead of replacing
  hideOriginalElement(messageEl);

  // Insert translated element after the hidden original
  messageEl.insertAdjacentElement('afterend', translatedEl);

  // Clone original for fallback restoration
  const originalEl = messageEl.cloneNode(true);
  originalEl.style.cssText = '';
  originalEl.removeAttribute('data-shadow-original');

  // Generate content key for new translations
  const contentKey = cached?.contentKey || generateContentKey(speaker, originalText, getTimeBucket());

  // Store state
  translationState.set(container, {
    originalText,
    originalEl,
    translatedText: cached?.translatedText || null,
    translatedEl,
    contentKey,
    lastTranslatedLength: originalText.length,
    shadowOriginalEl: messageEl,
    speakerName: speaker,
    isIncremental: false, // Breakdown mode doesn't support incremental updates
    breakdownData: cached?.breakdownData || null,
    isExpanded: true
  });

  // Mark as active
  activeContentKeys.add(contentKey);

  // If cached with breakdown, render panel and we're done
  if (cached?.breakdownData) {
    renderBreakdownPanel(container, cached.breakdownData, speaker);
    debugLog('TRANSLATE', 'Applied cached breakdown');
    return;
  }

  debugLog('TRANSLATE', 'Starting Japanese analysis');

  try {
    const breakdownData = await analyzeJapaneseWithGemini(originalText);

    // Check if user toggled off while analysis was in flight
    if (!translationState.has(container)) {
      debugLog('TRANSLATE', 'User toggled off during analysis, discarding result');
      return;
    }

    // Hide the loading placeholder
    translatedEl.style.display = 'none';
    translatedEl.removeAttribute('data-loading');

    // Update state with breakdown data
    const state = translationState.get(container);
    state.breakdownData = breakdownData;
    state.translatedText = breakdownData.translation;

    // Render the breakdown panel
    renderBreakdownPanel(container, breakdownData, speaker);

    // Store in cache for persistence
    translationCache.set(contentKey, {
      translatedText: breakdownData.translation,
      breakdownData: breakdownData,
      timestamp: Date.now(),
      speaker,
      originalText
    });
    debugLog('CACHE-SET', `Cached breakdown: ${contentKey.slice(0, 50)}`);

    debugLog('TRANSLATE', 'Breakdown panel rendered');
  } catch (error) {
    console.error('Analysis error:', error);
    debugLog('TRANSLATE', 'Error:', error.message);

    // Check if user toggled off
    if (!translationState.has(container)) return;

    translatedEl.textContent = `[Error: ${error.message}]`;
    translatedEl.style.display = '';
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
 * Auto-process the second-to-last caption card when a new card appears
 * The last card is skipped because it's still being updated as the speaker talks
 */
async function autoProcessPreviousCard() {
  // Get all caption containers in DOM order
  const allContainers = document.querySelectorAll('.nMcdL');

  // Need at least 2 containers to process the previous one
  if (allContainers.length < 2) {
    return;
  }

  // Get the second-to-last container (index -2)
  const previousContainer = allContainers[allContainers.length - 2];

  // Skip if already processed (has breakdownData in translationState)
  if (translationState.has(previousContainer)) {
    const state = translationState.get(previousContainer);
    if (state.breakdownData) {
      debugLog('AUTO-PROCESS', 'Previous card already has breakdown, skipping');
      return;
    }
  }

  // Find the message element
  const messageEl = previousContainer.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original])');
  if (!messageEl) {
    debugLog('AUTO-PROCESS', 'No message element found in previous card');
    return;
  }

  const originalText = messageEl.textContent?.trim();
  if (!originalText) {
    debugLog('AUTO-PROCESS', 'No text in previous card');
    return;
  }

  // Get speaker name
  const nameEl = previousContainer.querySelector('.NWpY1d');
  const speaker = nameEl?.textContent?.trim() || '(unknown)';

  debugLog('AUTO-PROCESS', `Processing previous card: speaker="${speaker}", text="${originalText.slice(0, 40)}..."`);

  // Check cache first
  const cached = findCachedTranslation(speaker, originalText);

  // Create placeholder element
  const translatedEl = document.createElement('div');
  translatedEl.className = messageEl.className;
  translatedEl.setAttribute('data-translated', 'true');

  if (cached?.breakdownData) {
    translatedEl.style.display = 'none';
    debugLog('AUTO-PROCESS', 'Using cached breakdown');
  } else {
    translatedEl.setAttribute('data-loading', 'true');
    translatedEl.textContent = 'Analyzing Japanese...';
  }

  // Shadow element strategy
  hideOriginalElement(messageEl);
  messageEl.insertAdjacentElement('afterend', translatedEl);

  // Clone original for fallback
  const originalEl = messageEl.cloneNode(true);
  originalEl.style.cssText = '';
  originalEl.removeAttribute('data-shadow-original');

  // Generate content key
  const contentKey = cached?.contentKey || generateContentKey(speaker, originalText, getTimeBucket());

  // Store state
  translationState.set(previousContainer, {
    originalText,
    originalEl,
    translatedText: cached?.translatedText || null,
    translatedEl,
    contentKey,
    lastTranslatedLength: originalText.length,
    shadowOriginalEl: messageEl,
    speakerName: speaker,
    isIncremental: false,
    breakdownData: cached?.breakdownData || null,
    isExpanded: true
  });

  // Mark as active
  activeContentKeys.add(contentKey);

  // If cached, render and return
  if (cached?.breakdownData) {
    renderBreakdownPanel(previousContainer, cached.breakdownData, speaker);
    debugLog('AUTO-PROCESS', 'Applied cached breakdown');
    return;
  }

  // Analyze with Gemini
  try {
    const breakdownData = await analyzeJapaneseWithGemini(originalText);

    // Check if state still exists
    if (!translationState.has(previousContainer)) {
      debugLog('AUTO-PROCESS', 'State removed during analysis, discarding');
      return;
    }

    // Hide loading placeholder
    translatedEl.style.display = 'none';
    translatedEl.removeAttribute('data-loading');

    // Update state
    const state = translationState.get(previousContainer);
    state.breakdownData = breakdownData;
    state.translatedText = breakdownData.translation;

    // Render breakdown panel
    renderBreakdownPanel(previousContainer, breakdownData, speaker);

    // Cache the result
    translationCache.set(contentKey, {
      translatedText: breakdownData.translation,
      breakdownData: breakdownData,
      timestamp: Date.now(),
      speaker,
      originalText
    });
    debugLog('AUTO-PROCESS', 'Breakdown complete and cached');

  } catch (error) {
    console.error('Auto-process error:', error);
    debugLog('AUTO-PROCESS', 'Error:', error.message);

    if (!translationState.has(previousContainer)) return;

    translatedEl.textContent = `[Error: ${error.message}]`;
    translatedEl.style.display = '';
    translatedEl.removeAttribute('data-loading');
    translatedEl.setAttribute('data-error', 'true');

    // Clean up after 3 seconds
    setTimeout(() => {
      if (translationState.has(previousContainer)) {
        removeOverlay(previousContainer);
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
    const messageEl = container.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original])');
    const speaker = nameEl?.textContent?.trim() || '(unknown)';
    const originalText = messageEl?.textContent?.trim() || '';

    debugLog('SETUP', `New container: speaker="${speaker}", text="${originalText.slice(0, 40)}..."`);

    // Auto-apply cached breakdown if this content is actively displayed
    if (originalText && messageEl && activeContentKeys.size > 0) {
      const cached = findCachedTranslation(speaker, originalText);
      if (cached && activeContentKeys.has(cached.contentKey)) {
        debugLog('AUTO-APPLY', `Re-applying breakdown to new container: ${originalText.slice(0, 40)}`);

        // Create translated element (hidden placeholder)
        const translatedEl = document.createElement('div');
        translatedEl.className = messageEl.className;
        translatedEl.setAttribute('data-translated', 'true');
        translatedEl.style.display = 'none';

        // Use shadow element approach
        hideOriginalElement(messageEl);
        messageEl.insertAdjacentElement('afterend', translatedEl);

        // Clone original for fallback restoration
        const originalEl = messageEl.cloneNode(true);
        originalEl.style.cssText = '';
        originalEl.removeAttribute('data-shadow-original');

        // Store state for the new container with breakdown data
        translationState.set(container, {
          originalText,
          originalEl,
          translatedText: cached.translatedText,
          translatedEl,
          contentKey: cached.contentKey,
          lastTranslatedLength: originalText.length,
          shadowOriginalEl: messageEl,
          speakerName: speaker,
          isIncremental: false,
          breakdownData: cached.breakdownData || null,
          isExpanded: true
        });

        // Render breakdown panel if we have data
        if (cached.breakdownData) {
          renderBreakdownPanel(container, cached.breakdownData, speaker);
        }
      }
    }
  });

  // Auto-process the previous card when new containers are added
  if (containers.length > 0) {
    autoProcessPreviousCard();
  }
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

    // Handle characterData mutations for visual delta display (no auto-translation)
    if (mutation.type === 'characterData') {
      // Check if this mutation is inside a shadow original element
      const shadowEl = mutation.target.parentElement?.closest('[data-shadow-original]');
      if (shadowEl) {
        const container = shadowEl.closest('.nMcdL');
        if (container && translationState.has(container)) {
          const state = translationState.get(container);
          if (state.breakdownData) {
            // Show new text in breakdown panel without processing
            updateBreakdownDelta(container);
          } else if (state.isIncremental) {
            // Only update visual display - user must click to translate
            updateVisualDelta(container);
          }
        }
      }
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

  // if (addedCount > 0 || removedCount > 0) {
  //   const now = Date.now();
  //   if (now - lastMutationLogTime > 1000) {
  //     debugLog('MUTATION', `Batch: +${addedCount} / -${removedCount} nodes`);
  //     lastMutationLogTime = now;
  //   }
  // }

  // Clean up stale state: containers no longer in DOM
  // Try to re-associate with new containers that have matching content
  for (const [container, state] of translationState) {
    if (!document.body.contains(container)) {
      debugLog('CLEANUP', 'Stale container detected, attempting re-association');

      // Cancel any pending delta translations for this container
      const pendingTimeout = pendingDeltas.get(container);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDeltas.delete(container);
      }

      // Try to find a new container with matching content
      let reassociated = false;
      if (state.contentKey && state.translatedText) {
        const allContainers = document.querySelectorAll('.nMcdL');
        for (const newContainer of allContainers) {
          // Skip if already has translation state
          if (translationState.has(newContainer)) continue;

          const nameEl = newContainer.querySelector('.NWpY1d');
          const messageEl = newContainer.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original])');
          const speaker = nameEl?.textContent?.trim() || '(unknown)';
          const text = messageEl?.textContent?.trim() || '';

          if (!text || !messageEl) continue;

          // Check if content matches
          const cached = findCachedTranslation(speaker, text);
          if (cached && cached.contentKey === state.contentKey) {
            debugLog('REASSOC', `Found matching container for: ${text.slice(0, 40)}`);

            // Create new translated element
            const translatedEl = document.createElement('div');
            translatedEl.className = messageEl.className;
            translatedEl.setAttribute('data-translated', 'true');
            translatedEl.textContent = state.translatedText;

            // Disconnect observer during our DOM modification
            observer.disconnect();

            // Use shadow element approach for incremental tracking
            hideOriginalElement(messageEl);
            messageEl.insertAdjacentElement('afterend', translatedEl);

            // Clone original for fallback restoration
            const originalEl = messageEl.cloneNode(true);
            originalEl.style.cssText = '';
            originalEl.removeAttribute('data-shadow-original');

            // Store state for the new container with incremental tracking
            translationState.set(newContainer, {
              originalText: text,
              originalEl,
              translatedText: state.translatedText,
              translatedEl,
              contentKey: state.contentKey,
              lastTranslatedLength: text.length,
              shadowOriginalEl: messageEl,
              speakerName: speaker,
              isIncremental: true
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
    // BUT keep shadow original elements (they receive text updates)
    const originals = container.querySelectorAll('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original])');
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

    // (C) Restore text if Meet overwrote it (but NOT if we're in the middle of updating or showing delta)
    // Skip this check if the element has data-updating or data-has-delta attribute
    if (state.translatedText && state.translatedEl &&
        !state.translatedEl.hasAttribute('data-updating') &&
        !state.translatedEl.hasAttribute('data-has-delta') &&
        state.translatedEl.textContent !== state.translatedText) {
      if (!didFight) { observer.disconnect(); didFight = true; }
      // debugLog('FIGHT-C', `Text mismatch — has: "${state.translatedEl.textContent?.slice(0, 40)}", want: "${state.translatedText?.slice(0, 40)}"`);
      state.translatedEl.textContent = state.translatedText;
    }

    // (D) Re-insert breakdown panel if dislodged
    if (state.breakdownData && !container.querySelector('.breakdown-panel')) {
      if (!didFight) { observer.disconnect(); didFight = true; }
      // debugLog('FIGHT-D', 'Re-inserting dislodged breakdown panel');
      renderBreakdownPanel(container, state.breakdownData, state.speakerName, state.isExpanded);
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
