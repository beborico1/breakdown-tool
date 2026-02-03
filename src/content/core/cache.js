import { debugLog } from './debug.js';
import { translationCache, activeContentKeys, CACHE_MAX_AGE_MS } from './state.js';
import { hashText } from '../utils/text.js';

/**
 * Get time bucket (10-second windows) to differentiate duplicate phrases
 * @returns {number}
 */
export function getTimeBucket() {
  return Math.floor(Date.now() / 10000);
}

/**
 * Generate a stable content key for caching translations
 * @param {string} speaker
 * @param {string} text
 * @param {number} timeBucket
 * @returns {string}
 */
export function generateContentKey(speaker, text, timeBucket) {
  return `${speaker}|${hashText(text)}|${timeBucket}`;
}

/**
 * Find a cached translation for the given speaker and text
 * Searches recent time buckets to handle edge cases
 * @param {string} speaker
 * @param {string} text
 * @returns {{translatedText: string, contentKey: string, breakdownData: Object|null}|null}
 */
export function findCachedTranslation(speaker, text) {
  const currentBucket = getTimeBucket();
  // Check current and previous 2 buckets (30-second window)
  for (let offset = 0; offset <= 2; offset++) {
    const key = generateContentKey(speaker, text, currentBucket - offset);
    const cached = translationCache.get(key);
    if (cached && cached.translatedText) {
      return {
        translatedText: cached.translatedText,
        contentKey: key,
        breakdownData: cached.breakdownData || null
      };
    }
  }
  return null;
}

/**
 * Prune old cache entries that are no longer active
 */
export function pruneTranslationCache() {
  const now = Date.now();
  for (const [key, value] of translationCache) {
    // Keep if actively displayed or recent
    if (activeContentKeys.has(key)) continue;
    if (now - value.timestamp < CACHE_MAX_AGE_MS) continue;
    translationCache.delete(key);
    debugLog('CACHE-PRUNE', `Removed stale entry: ${key.slice(0, 50)}`);
  }
}
