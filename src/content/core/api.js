import { debugLog } from './debug.js';
import { incrementApiCallCount } from './state.js';
import { splitJapaneseText } from '../utils/text.js';

/**
 * Get the Gemini API key from storage
 * @returns {Promise<string|null>}
 */
export async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['geminiApiKey'], (result) => {
      resolve(result.geminiApiKey || null);
    });
  });
}

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const CLOUD_API_BASE = 'https://generativelanguage.googleapis.com';

// Upper bound for a single service-worker proxy round-trip. In MV3 the worker can
// be torn down mid-request and drop the sendMessage callback without firing
// chrome.runtime.lastError, which would hang the awaiting caller forever (and, in
// minimalistic mode, leave ms.isProcessing stuck true). Reject past this so the
// caller's catch can recover.
const SW_PROXY_TIMEOUT_MS = 30000;

/**
 * Synchronously-readable mirror of the offline-NLP setting. Defaults to ON to match
 * the storage default (`useOfflineNlp !== false`). Synchronous callers (e.g. the
 * cached-word highlighter, which must decide instantly whether to run) read this via
 * isOfflineNlpEnabledSync(); it is kept fresh below by an initial read + storage
 * listener, and by isOfflineNlpEnabled() whenever it resolves.
 */
let _offlineNlpCached = true;

try {
  chrome.storage.sync.get(['useOfflineNlp'], (r) => { _offlineNlpCached = r?.useOfflineNlp !== false; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.useOfflineNlp) {
      _offlineNlpCached = changes.useOfflineNlp.newValue !== false;
    }
  });
} catch { /* non-extension context (tests) */ }

/**
 * Whether the user has opted into the offline NLP beta pipeline
 * (kuromoji + JMdict + Chrome Translator API). Returns false on any error.
 */
export async function isOfflineNlpEnabled() {
  return new Promise((resolve) => {
    try {
      // Default to ON: only false when user has explicitly toggled it off.
      chrome.storage.sync.get(['useOfflineNlp'], (r) => {
        _offlineNlpCached = r?.useOfflineNlp !== false;
        resolve(_offlineNlpCached);
      });
    } catch { resolve(false); }
  });
}

/**
 * Synchronous read of the cached offline-NLP flag. Use when an async await is not
 * possible (e.g. inside the synchronous highlighter pass).
 * @returns {boolean}
 */
export function isOfflineNlpEnabledSync() {
  return _offlineNlpCached;
}

/**
 * Round-trip a request to the offscreen NLP pipeline via the service worker.
 * Returns the offscreen handler's response object: { ok, result?, text?, error? }.
 */
function nlpRequest(op, text) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('NLP proxy timeout'));
    }, SW_PROXY_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage({ type: 'kaigi-nlp-proxy', op, text }, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('no response from NLP proxy'));
          return;
        }
        resolve(response);
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

/**
 * Resolve apiBase + apiKey together.
 * @returns {Promise<{apiBase: string, apiKey: string}>}
 */
async function resolveAuth() {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('No API key. Set it in the extension popup.');
  }
  return { apiBase: CLOUD_API_BASE, apiKey };
}

/**
 * Fetch proxy via the service worker. Runs from extension origin with
 * host_permissions so it bypasses page CSP and CORS. Returns a Response-like
 * object compatible with the call sites (.ok, .status, .json(), .text()).
 */
async function kaigiFetch(url, init) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('background fetch timeout'));
    }, SW_PROXY_TIMEOUT_MS);
    chrome.runtime.sendMessage({ type: 'kaigi-fetch', url, init }, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('no response from background fetch proxy'));
        return;
      }
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      const text = response.text || '';
      resolve({
        ok: response.ok,
        status: response.status,
        async json() { return JSON.parse(text); },
        async text() { return text; },
      });
    });
  });
}

/**
 * Get the selected Gemini model from storage
 * @returns {Promise<string>}
 */
export async function getModel() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['geminiModel'], (result) => {
      resolve(result.geminiModel || DEFAULT_MODEL);
    });
  });
}

/**
 * Extract a per-modality delta from a Gemini `usageMetadata` object.
 * Returns { textIn, audioIn, imageIn, out, total }. Output includes
 * thinking tokens, which Google bills as output on 2.5 models.
 */
function deltaFromUsageMetadata(meta) {
  if (!meta) return null;
  const delta = { textIn: 0, audioIn: 0, imageIn: 0, out: 0, total: 0 };
  const details = Array.isArray(meta.promptTokensDetails) ? meta.promptTokensDetails : [];
  let promptCounted = 0;
  for (const d of details) {
    const n = Number(d?.tokenCount) || 0;
    promptCounted += n;
    switch (d?.modality) {
      case 'AUDIO': delta.audioIn += n; break;
      case 'IMAGE':
      case 'VIDEO': delta.imageIn += n; break;
      default: delta.textIn += n; break;
    }
  }
  // Fall back to promptTokenCount when the per-modality breakdown is missing.
  if (promptCounted === 0 && meta.promptTokenCount) {
    delta.textIn = Number(meta.promptTokenCount) || 0;
  }
  delta.out = (Number(meta.candidatesTokenCount) || 0)
            + (Number(meta.thoughtsTokenCount) || 0);
  delta.total = Number(meta.totalTokenCount)
             || (delta.textIn + delta.audioIn + delta.imageIn + delta.out);
  return delta;
}

const EMPTY_USAGE = { textIn: 0, audioIn: 0, imageIn: 0, out: 0, total: 0 };

/**
 * Serialized write queue: Chrome storage get/set is not atomic, so concurrent
 * callers can clobber each other's increments. Chain all writes through one
 * promise so increments are applied one at a time within this context.
 */
let usageWriteQueue = Promise.resolve();
function updateTokenUsage(usageMetadata) {
  const delta = deltaFromUsageMetadata(usageMetadata);
  if (!delta || delta.total <= 0) return usageWriteQueue;
  usageWriteQueue = usageWriteQueue.then(() => new Promise((resolve) => {
    chrome.storage.local.get(['tokenUsage'], (result) => {
      const raw = result.tokenUsage;
      const cur = (typeof raw === 'object' && raw !== null)
        ? { ...EMPTY_USAGE, ...raw }
        // Migrate legacy scalar: assume all prior tokens were text input.
        : { ...EMPTY_USAGE, textIn: Number(raw) || 0, total: Number(raw) || 0 };
      const next = {
        textIn:  cur.textIn  + delta.textIn,
        audioIn: cur.audioIn + delta.audioIn,
        imageIn: cur.imageIn + delta.imageIn,
        out:     cur.out     + delta.out,
        total:   cur.total   + delta.total,
      };
      chrome.storage.local.set({ tokenUsage: next }, () => {
        debugLog('API', `Token usage +${delta.total} (text:${delta.textIn} audio:${delta.audioIn} img:${delta.imageIn} out:${delta.out}) → total ${next.total}`);
        resolve();
      });
    });
  }));
  return usageWriteQueue;
}

/**
 * Analyze Japanese text in chunks when the full text causes truncation
 * @param {string} text - Full Japanese text to analyze
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<{original: string, translation: string, words: Array}>}
 */
async function analyzeJapaneseChunked(text, apiKey) {
  debugLog('API-BREAKDOWN', 'Response truncated, retrying with chunks...');

  const chunks = splitJapaneseText(text, 30);
  debugLog('API-BREAKDOWN', `Split into ${chunks.length} chunks:`, chunks);

  const allWords = [];
  let fullTranslation = '';

  for (const chunk of chunks) {
    try {
      const result = await analyzeJapaneseWithGemini(chunk, { noRetry: true });
      if (!result.truncated) {
        allWords.push(...result.words);
        fullTranslation += result.translation + ' ';
      } else {
        // Even smaller chunk still truncated - use as-is
        debugLog('API-BREAKDOWN', `Chunk still truncated: "${chunk.slice(0, 20)}..."`);
        allWords.push({
          japanese: chunk,
          reading: '',
          romaji: chunk,
          english: '[truncated]',
          type: 'expression'
        });
      }
    } catch (error) {
      debugLog('API-BREAKDOWN', `Chunk error for "${chunk.slice(0, 20)}...":`, error.message);
      // Add chunk as unparsed word on error
      allWords.push({
        japanese: chunk,
        reading: '',
        romaji: chunk,
        english: '[error]',
        type: 'expression'
      });
    }
  }

  return {
    original: text,
    translation: fullTranslation.trim(),
    words: allWords
  };
}

/**
 * Analyze Japanese text with Gemini and return structured breakdown
 * @param {string} text - Japanese text to analyze
 * @param {Object} options - Options object
 * @param {boolean} options.noRetry - If true, don't retry with chunking on truncation
 * @returns {Promise<{original: string, translation: string, words: Array<{japanese: string, reading: string, romaji: string, english: string, type: string}>, truncated?: boolean}>}
 */
export async function analyzeJapaneseWithGemini(text, options = {}) {
  if (await isOfflineNlpEnabled()) {
    debugLog('API-BREAKDOWN', 'Using offline NLP pipeline');
    const response = await nlpRequest('analyze', text);
    if (!response.ok) throw new Error(response.error || 'offline NLP failed');
    return response.result;
  }

  const { apiBase, apiKey } = await resolveAuth();

  const model = await getModel();
  const callNum = incrementApiCallCount();

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

  debugLog('API-BREAKDOWN', `Call #${callNum}`);
  debugLog('API-BREAKDOWN', `INPUT (${text.length} chars):`, text);

  const response = await kaigiFetch(
    `${apiBase}/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
          responseMimeType: 'application/json',
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
  const finishReason = data.candidates?.[0]?.finishReason;
  let responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  // Track token usage
  const usageMetadata = data.usageMetadata;
  if (usageMetadata?.totalTokenCount) {
    updateTokenUsage(usageMetadata);
  }

  debugLog('API-BREAKDOWN', 'finishReason:', finishReason);
  debugLog('API-BREAKDOWN', 'Response length:', responseText?.length || 0);

  if (!responseText) {
    debugLog('API-BREAKDOWN', 'No response text:', data);
    throw new Error('No analysis returned');
  }

  // Check for truncation before parsing
  if (finishReason === 'MAX_TOKENS') {
    debugLog('API-BREAKDOWN', 'Response end:', responseText.slice(-100));
    if (!options?.noRetry) {
      // Signal to retry with chunking
      return analyzeJapaneseChunked(text, apiKey);
    }
    // In noRetry mode, signal truncation to caller
    return { truncated: true, original: text };
  }

  try {
    const breakdown = parseBreakdownResponse(responseText);
    debugLog('API-BREAKDOWN', `OUTPUT: ${breakdown.words.length} words parsed`);
    return breakdown;
  } catch (parseError) {
    debugLog('API-BREAKDOWN', 'JSON parse error:', parseError.message);
    debugLog('API-BREAKDOWN', 'Raw response:', responseText.slice(0, 200));
    debugLog('API-BREAKDOWN', 'Response end:', responseText.slice(-100));

    // If JSON parse failed and we haven't retried yet, try chunking
    // (truncation might have occurred even without MAX_TOKENS finishReason)
    if (!options?.noRetry && parseError instanceof SyntaxError) {
      debugLog('API-BREAKDOWN', 'JSON incomplete, attempting chunked retry...');
      return analyzeJapaneseChunked(text, apiKey);
    }

    throw new Error('Failed to parse breakdown response');
  }
}

/**
 * Parse and validate a breakdown JSON response from Gemini
 * @param {string} responseText - Raw response text
 * @returns {Object} - Parsed breakdown object
 */
function parseBreakdownResponse(responseText) {
  let cleaned = responseText.trim();

  // Clean up potential markdown code blocks
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  const breakdown = JSON.parse(cleaned);

  // Validate structure
  if (!breakdown.original || !breakdown.translation || !Array.isArray(breakdown.words)) {
    throw new Error('Invalid breakdown structure');
  }

  return breakdown;
}

/**
 * Analyze audio with Gemini multimodal API for Japanese transcription + breakdown
 * @param {string} base64Audio - Base64-encoded audio data
 * @param {string} mimeType - Audio MIME type (e.g., 'audio/webm;codecs=opus')
 * @returns {Promise<{original: string, translation: string, words: Array}>}
 */
export async function analyzeAudioWithGemini(base64Audio, mimeType) {
  const { apiBase, apiKey } = await resolveAuth();

  const model = await getModel();
  const callNum = incrementApiCallCount();

  const prompt = `Listen to this Japanese audio and return ONLY valid JSON (no markdown, no code blocks, no explanation):
{
  "original": "the transcribed Japanese text",
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
- If no Japanese speech is detected, return {"original": "", "translation": "", "words": []}
- Break down ALL words including particles (は, が, を, に, etc.)
- For particles, use their grammatical function as english (e.g., "topic marker", "subject marker", "object marker")
- Keep word order matching the original sentence
- Use lowercase for romaji except for proper nouns
- For verbs, include the conjugated form as it appears`;

  debugLog('API-AUDIO', `Call #${callNum}`);

  const response = await kaigiFetch(
    `${apiBase}/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Audio
              }
            },
            {
              text: prompt
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 65536,
          responseMimeType: 'application/json',
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json();
    debugLog('API-AUDIO', 'Error response:', error);
    throw new Error(error.error?.message || 'Audio analysis failed');
  }

  const data = await response.json();
  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  // Track token usage
  const usageMetadata = data.usageMetadata;
  if (usageMetadata?.totalTokenCount) {
    updateTokenUsage(usageMetadata);
  }

  debugLog('API-AUDIO', 'Response length:', responseText?.length || 0);

  if (!responseText) {
    debugLog('API-AUDIO', 'No response text:', data);
    throw new Error('No audio analysis returned');
  }

  try {
    const breakdown = parseBreakdownResponse(responseText);
    debugLog('API-AUDIO', `OUTPUT: ${breakdown.words.length} words parsed`);
    return breakdown;
  } catch (parseError) {
    debugLog('API-AUDIO', 'JSON parse error:', parseError.message);
    debugLog('API-AUDIO', 'Raw response:', responseText.slice(0, 200));
    throw new Error('Failed to parse audio analysis response');
  }
}

/**
 * Fast transcribe-only call: returns just the Japanese transcription text
 * (no breakdown, no translation) so the UI can show gray text immediately
 * while the full breakdown call is still in flight.
 * @param {string} base64Audio - Base64-encoded audio data
 * @param {string} mimeType - Audio MIME type (e.g., 'audio/webm;codecs=opus')
 * @returns {Promise<string>} - Raw Japanese transcription text
 */
export async function transcribeAudioWithGemini(base64Audio, mimeType) {
  const { apiBase, apiKey } = await resolveAuth();

  const model = await getModel();
  const callNum = incrementApiCallCount();

  const prompt = `Transcribe this Japanese audio. Output ONLY the transcribed Japanese text, nothing else. No translation, no explanation, no quotes, no markdown. If no Japanese speech is detected, output an empty string.`;

  debugLog('API-TRANSCRIBE', `Call #${callNum}`);

  const response = await kaigiFetch(
    `${apiBase}/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Audio
              }
            },
            {
              text: prompt
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json();
    debugLog('API-TRANSCRIBE', 'Error response:', error);
    throw new Error(error.error?.message || 'Transcription failed');
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  const usageMetadata = data.usageMetadata;
  if (usageMetadata?.totalTokenCount) {
    updateTokenUsage(usageMetadata);
  }

  if (text === undefined || text === null) {
    debugLog('API-TRANSCRIBE', 'No response text:', data);
    throw new Error('No transcription returned');
  }

  const cleaned = text.trim().replace(/^["「『]|["」』]$/g, '').trim();
  debugLog('API-TRANSCRIBE', `OUTPUT (${cleaned.length} chars):`, cleaned);
  return cleaned;
}

/**
 * Translate text using Gemini 2.5 Flash
 * @param {string} text - Text to translate
 * @param {Object} options - Translation options
 * @param {string} options.previousTranslation - Previous translation for context (delta mode)
 * @param {boolean} options.isDelta - Whether this is a delta translation
 * @returns {Promise<string>} - Translated text
 */
export async function translateWithGemini(text, options = {}) {
  if (await isOfflineNlpEnabled()) {
    debugLog('API', 'Using offline NLP translation');
    const response = await nlpRequest('translate', text);
    if (!response.ok) throw new Error(response.error || 'offline translate failed');
    return response.text || '';
  }

  const { apiBase, apiKey } = await resolveAuth();

  const model = await getModel();
  const callNum = incrementApiCallCount();

  let prompt;
  if (options.isDelta && options.previousTranslation) {
    // Context-aware delta translation
    const contextSnippet = options.previousTranslation.slice(-50);
    prompt = `Continue this translation. Previous translation ended with: "${contextSnippet}"\n\nTranslate this continuation to English. Only output the translation of the new text, nothing else:\n\n${text}`;
  } else {
    prompt = `Translate the following text to English. Only output the translation, nothing else. If the text is already in English, output it as-is.\n\nText: ${text}`;
  }

  debugLog('API', `Call #${callNum}${options.isDelta ? ' (DELTA)' : ''}`);
  debugLog('API', `INPUT (${text.length} chars):`, text);
  debugLog('API', `FULL PROMPT:`, prompt);

  const response = await kaigiFetch(
    `${apiBase}/v1beta/models/${model}:generateContent?key=${apiKey}`,
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

  // Track token usage
  const usageMetadata = data.usageMetadata;
  if (usageMetadata?.totalTokenCount) {
    updateTokenUsage(usageMetadata);
  }

  if (!translatedText) {
    debugLog('API', 'No translation in response:', data);
    throw new Error('No translation returned');
  }

  debugLog('API', `OUTPUT (${translatedText.trim().length} chars):`, translatedText.trim());
  return translatedText.trim();
}

/**
 * Translate text to Japanese using Gemini
 * @param {string} text - Text to translate to Japanese
 * @returns {Promise<string>} - Japanese translation
 */
export async function translateToJapaneseWithGemini(text) {
  const { apiBase, apiKey } = await resolveAuth();

  const model = await getModel();
  const callNum = incrementApiCallCount();

  const prompt = `Translate the following text to Japanese. Only output the translation, nothing else. If the text is already in Japanese, output it as-is.\n\nText: ${text}`;

  debugLog('API', `Call #${callNum} (TO-JAPANESE)`);
  debugLog('API', `INPUT (${text.length} chars):`, text);

  const response = await kaigiFetch(
    `${apiBase}/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
    throw new Error(error.error?.message || 'Translation to Japanese failed');
  }

  const data = await response.json();
  const translatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  // Track token usage
  const usageMetadata = data.usageMetadata;
  if (usageMetadata?.totalTokenCount) {
    updateTokenUsage(usageMetadata);
  }

  if (!translatedText) {
    debugLog('API', 'No translation in response:', data);
    throw new Error('No translation returned');
  }

  debugLog('API', `OUTPUT (${translatedText.trim().length} chars):`, translatedText.trim());
  return translatedText.trim();
}
