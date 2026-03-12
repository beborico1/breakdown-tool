import { debugLog } from './debug.js';

/**
 * Word Cache Module
 * Persistent storage for analyzed Japanese words using chrome.storage.local
 * Structure: { japanese: { reading, romaji, english, type, lastUsed } }
 */

// In-memory cache loaded from storage
let wordCache = new Map();

// Cache staleness threshold (30 days)
const WORD_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Must contain at least one Japanese character (hiragana, katakana, or kanji)
const JAPANESE_CHAR_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/;

// Debounce timer for saving
let saveTimeout = null;
const SAVE_DEBOUNCE_MS = 1000;

/**
 * Initialize word cache from chrome.storage.local
 * @returns {Promise<void>}
 */
export async function initWordCache() {
  try {
    const result = await chrome.storage.local.get('wordCache');
    if (result.wordCache && typeof result.wordCache === 'object') {
      wordCache = new Map(Object.entries(result.wordCache));
      debugLog('WORD-CACHE', `Loaded ${wordCache.size} cached words`);
      // Prune stale entries on startup
      await pruneWordCache();
    } else {
      wordCache = new Map();
      debugLog('WORD-CACHE', 'Initialized empty word cache');
    }
  } catch (error) {
    debugLog('WORD-CACHE', 'Error loading word cache:', error.message);
    wordCache = new Map();
  }
}

/**
 * Save word cache to chrome.storage.local (debounced)
 */
function saveWordCache() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(async () => {
    try {
      const cacheObj = Object.fromEntries(wordCache);
      await chrome.storage.local.set({ wordCache: cacheObj });
      debugLog('WORD-CACHE', `Saved ${wordCache.size} words to storage`);
    } catch (error) {
      debugLog('WORD-CACHE', 'Error saving word cache:', error.message);
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Cache words from analysis results
 * @param {Array<{japanese: string, reading: string, romaji: string, english: string, type: string}>} words
 */
export function cacheWords(words) {
  if (!Array.isArray(words) || words.length === 0) return;

  const now = Date.now();
  let addedCount = 0;

  for (const word of words) {
    if (!word.japanese || !JAPANESE_CHAR_RE.test(word.japanese)) continue;

    const existing = wordCache.get(word.japanese);
    const entry = {
      reading: word.reading || '',
      romaji: word.romaji || '',
      english: word.english || '',
      type: word.type || 'other',
      lastUsed: now
    };

    // Only update if new or has better data
    if (!existing ||
        (entry.english && !existing.english) ||
        (entry.reading && !existing.reading)) {
      wordCache.set(word.japanese, entry);
      addedCount++;
    } else {
      // Just update lastUsed timestamp
      existing.lastUsed = now;
      wordCache.set(word.japanese, existing);
    }
  }

  if (addedCount > 0) {
    debugLog('WORD-CACHE', `Cached ${addedCount} new words, total: ${wordCache.size}`);
  }
  saveWordCache();
}

/**
 * Get a single cached word
 * @param {string} japanese - Japanese word to lookup
 * @returns {{reading: string, romaji: string, english: string, type: string, lastUsed: number}|null}
 */
export function getCachedWord(japanese) {
  const entry = wordCache.get(japanese);
  if (entry) {
    // Update lastUsed on access
    entry.lastUsed = Date.now();
    wordCache.set(japanese, entry);
    return entry;
  }
  return null;
}

/**
 * Find all known words in a text string
 * Uses a greedy longest-match approach
 * @param {string} text - Text to scan for known words
 * @returns {Array<{word: string, start: number, end: number, data: Object}>}
 */
export function getCachedWords(text) {
  if (!text || wordCache.size === 0) return [];

  const matches = [];
  const sortedWords = Array.from(wordCache.keys())
    .filter(w => w.length > 0 && JAPANESE_CHAR_RE.test(w))
    .sort((a, b) => b.length - a.length); // Longest first for greedy matching

  // Track which positions have been matched
  const matched = new Set();

  for (const word of sortedWords) {
    let startIndex = 0;
    while (true) {
      const pos = text.indexOf(word, startIndex);
      if (pos === -1) break;

      // Check if any position in this match is already covered
      let overlaps = false;
      for (let i = pos; i < pos + word.length; i++) {
        if (matched.has(i)) {
          overlaps = true;
          break;
        }
      }

      if (!overlaps) {
        // Mark positions as matched
        for (let i = pos; i < pos + word.length; i++) {
          matched.add(i);
        }

        const data = wordCache.get(word);
        matches.push({
          word,
          start: pos,
          end: pos + word.length,
          data: {
            japanese: word,
            reading: data.reading,
            romaji: data.romaji,
            english: data.english,
            type: data.type
          }
        });
      }

      startIndex = pos + 1;
    }
  }

  // Sort by position for proper rendering
  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Remove stale cache entries (older than 30 days)
 * @returns {Promise<void>}
 */
export async function pruneWordCache() {
  const now = Date.now();
  let prunedCount = 0;

  for (const [word, entry] of wordCache) {
    if (now - entry.lastUsed > WORD_CACHE_MAX_AGE_MS) {
      wordCache.delete(word);
      prunedCount++;
    }
  }

  if (prunedCount > 0) {
    debugLog('WORD-CACHE', `Pruned ${prunedCount} stale words`);
    saveWordCache();
  }
}

/**
 * Get cache statistics
 * @returns {{size: number, oldestEntry: number|null}}
 */
export function getWordCacheStats() {
  let oldest = null;
  for (const entry of wordCache.values()) {
    if (!oldest || entry.lastUsed < oldest) {
      oldest = entry.lastUsed;
    }
  }
  return {
    size: wordCache.size,
    oldestEntry: oldest
  };
}
