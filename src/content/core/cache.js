import { debugLog } from './debug.js';
import { translationCache, activeContentKeys, CACHE_MAX_AGE_MS, breakdownCache } from './state.js';
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

  // Fallback: text-only breakdown cache (ensures consistent tokenization)
  const textHash = hashText(text);
  const fallback = breakdownCache.get(textHash);
  if (fallback?.breakdownData) {
    debugLog('CACHE-FALLBACK', `Text-only cache hit for: ${text.slice(0, 40)}`);
    return {
      translatedText: fallback.breakdownData.translation,
      contentKey: generateContentKey(speaker, text, currentBucket),
      breakdownData: fallback.breakdownData
    };
  }

  return null;
}

/**
 * Store breakdown data in the text-only cache for consistent re-processing
 * @param {string} text - Original text
 * @param {Object} breakdownData - Breakdown data from API
 */
export function cacheBreakdown(text, breakdownData) {
  const textHash = hashText(text);
  breakdownCache.set(textHash, {
    breakdownData,
    timestamp: Date.now()
  });
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
  // Prune text-only breakdown cache
  for (const [hash, value] of breakdownCache) {
    if (now - value.timestamp < CACHE_MAX_AGE_MS) continue;
    breakdownCache.delete(hash);
  }
}
