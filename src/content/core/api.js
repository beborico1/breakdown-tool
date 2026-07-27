import { debugLog } from './debug.js';

// Upper bound for a single service-worker proxy round-trip. In MV3 the worker can
// be torn down mid-request and drop the sendMessage callback without firing
// chrome.runtime.lastError, which would hang the awaiting caller forever (and, in
// minimalistic mode, leave ms.isProcessing stuck true). Reject past this so the
// caller's catch can recover.
const SW_PROXY_TIMEOUT_MS = 30000;

/**
 * Round-trip a request to the offscreen NLP pipeline via the service worker.
 * Returns the offscreen handler's response object: { ok, result?, text?, error? }.
 * `timeoutMs` lets an interactive caller give up sooner than a batch one.
 */
function nlpRequest(op, text, timeoutMs = SW_PROXY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('NLP proxy timeout'));
    }, timeoutMs);
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

/** Interactive budget: a hover should give up long before the batch timeout. */
const CLAUSE_TRANSLATE_TIMEOUT_MS = 15000;

/**
 * Translate Japanese to English, swallowing failures.
 *
 * Returns '' on any failure so an interactive caller can render a fallback
 * instead of handling an error. Use translateToEnglish() where a failure must
 * be distinguishable from an empty translation.
 * @param {string} text
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
export async function translateJapanese(text, timeoutMs = CLAUSE_TRANSLATE_TIMEOUT_MS) {
  if (!text || !text.trim()) return '';
  try {
    const response = await nlpRequest('translate', text, timeoutMs);
    return response.ok ? (response.text || '') : '';
  } catch (e) {
    debugLog('API', 'clause translate failed:', e?.message);
    return '';
  }
}

/**
 * Translate Japanese to English, throwing on failure.
 *
 * The caption delta path distinguishes "translation failed" from "translated to
 * nothing" — it must not append an empty string to the running translation — so
 * it needs the throwing form rather than translateJapanese().
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function translateToEnglish(text) {
  const response = await nlpRequest('translate', text);
  if (!response.ok) throw new Error(response.error || 'translate failed');
  return response.text || '';
}

/**
 * Ask the offscreen document to load the tokenizer and start the translator
 * model download. Fire and forget: callers use this to hide a cold start, not to
 * sequence work.
 */
export function warmupNlp() {
  try {
    chrome.runtime.sendMessage({ type: 'kaigi-nlp-proxy', op: 'warmup', text: '' }, () => {
      void chrome.runtime.lastError; // a closed port here is not worth reporting
    });
  } catch { /* non-extension context */ }
}

/**
 * Full breakdown: per-word readings, romaji, glosses and part of speech, plus a
 * whole-sentence English translation.
 * @param {string} text
 * @returns {Promise<{original: string, translation: string, words: Array<{japanese: string, reading: string, romaji: string, english: string, type: string}>}>}
 */
export async function analyzeJapanese(text) {
  const response = await nlpRequest('analyze', text);
  if (!response.ok) throw new Error(response.error || 'analyze failed');
  return response.result;
}

/**
 * Per-word breakdown WITHOUT the whole-sentence translation. Used by the
 * all-sites colorizer, which shows only per-word colour + hover, so skipping the
 * translation removes the dominant per-block latency.
 * @param {string} text
 * @returns {Promise<{original: string, translation: string, words: Array}>}
 */
export async function analyzeJapaneseTokens(text) {
  const response = await nlpRequest('tokenize', text);
  if (!response.ok) throw new Error(response.error || 'tokenize failed');
  return response.result;
}
