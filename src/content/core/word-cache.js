import { debugLog } from './debug.js';

/**
 * Word Cache Module
 * Persistent storage for analyzed Japanese words using chrome.storage.local
 * Structure: { japanese: { reading, romaji, english, type, lastUsed } }
 */

// In-memory cache loaded from storage
let wordCache = new Map();

// Length of the longest matchable key. getCachedWords probes substrings of the
// input text against the cache rather than scanning the cache against the text,
// so it needs an upper bound on how far to look ahead from each position.
// Maintained on insert; recomputed after a load or a prune.
let maxKeyLen = 0;

/** Whether a cache key can ever be matched by getCachedWords. */
function isMatchableKey(word) {
  return word.length > 0 && JAPANESE_CHAR_RE.test(word);
}

function noteKey(word) {
  if (isMatchableKey(word) && word.length > maxKeyLen) maxKeyLen = word.length;
}

function recomputeMaxKeyLen() {
  maxKeyLen = 0;
  for (const word of wordCache.keys()) noteKey(word);
}

// Cache staleness threshold (30 days)
const WORD_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Must contain at least one Japanese character (hiragana, katakana, or kanji)
const JAPANESE_CHAR_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/;

// Debounce timers for saving. Two tiers, because the two reasons to save are
// not equally urgent:
//
//   content  — a new word, or a better gloss/reading for a known one. Worth
//              persisting promptly so a reload does not re-analyze it.
//   touch    — only lastUsed moved. This fires on every getCachedWord(), so
//              merely *reading* the cache used to trigger a full serialization
//              of every entry. It still has to be persisted (the 30-day TTL
//              prunes on lastUsed, so a word seen daily whose touches never
//              reached disk would eventually expire), but a minute of lag is
//              irrelevant against a 30-day window.
let saveTimeout = null;
const SAVE_DEBOUNCE_MS = 1000;
const TOUCH_SAVE_DEBOUNCE_MS = 60000;
let pendingSaveIsContent = false;

// Every site subsystem calls initWordCache() during startup, so a single frame
// asks for the cache up to four times. They all populate the same module-level
// Map, so the extra calls bought nothing but repeated storage round-trips, Map
// rebuilds and prune passes. Memoize the load; callers keep awaiting it.
let initPromise = null;

/**
 * Initialize word cache from chrome.storage.local. Idempotent — concurrent and
 * repeat callers share one load.
 * @returns {Promise<void>}
 */
export function initWordCache() {
  if (!initPromise) initPromise = loadWordCache();
  return initPromise;
}

async function loadWordCache() {
  try {
    const result = await chrome.storage.local.get('wordCache');
    if (result.wordCache && typeof result.wordCache === 'object') {
      wordCache = new Map(Object.entries(result.wordCache));
      recomputeMaxKeyLen();
      debugLog('WORD-CACHE', `Loaded ${wordCache.size} cached words`);
      // Prune stale entries on startup
      await pruneWordCache();
    } else {
      wordCache = new Map();
      maxKeyLen = 0;
      debugLog('WORD-CACHE', 'Initialized empty word cache');
    }
  } catch (error) {
    debugLog('WORD-CACHE', 'Error loading word cache:', error.message);
    wordCache = new Map();
    maxKeyLen = 0;
  }
}

/**
 * Save word cache to chrome.storage.local (debounced).
 * @param {{content?: boolean}} [opts] - content:true when entries were added or
 *   improved, rather than only touched. Content saves win: a pending slow touch
 *   save is pulled forward, never the other way round.
 */
function saveWordCache({ content = false } = {}) {
  if (content) pendingSaveIsContent = true;
  // A slow touch timer must not hold back a content save, but a content timer
  // already covers any touches that arrive before it fires.
  if (saveTimeout) {
    if (!content) return;
    clearTimeout(saveTimeout);
  }
  const delay = pendingSaveIsContent ? SAVE_DEBOUNCE_MS : TOUCH_SAVE_DEBOUNCE_MS;
  saveTimeout = setTimeout(async () => {
    saveTimeout = null;
    pendingSaveIsContent = false;
    try {
      const cacheObj = Object.fromEntries(wordCache);
      await chrome.storage.local.set({ wordCache: cacheObj });
      debugLog('WORD-CACHE', `Saved ${wordCache.size} words to storage`);
    } catch (error) {
      debugLog('WORD-CACHE', 'Error saving word cache:', error.message);
    }
  }, delay);
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
      noteKey(word.japanese);
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
  // Nothing new here means every word in this batch was already known and only
  // had its lastUsed bumped — that can wait for the slow tier.
  saveWordCache({ content: addedCount > 0 });
}

/**
 * Get a single cached word
 * @param {string} japanese - Japanese word to lookup
 * @returns {{reading: string, romaji: string, english: string, type: string, lastUsed: number}|null}
 */
export function getCachedWord(japanese) {
  const entry = wordCache.get(japanese);
  if (entry) {
    // Update lastUsed on access so the 30-day TTL keeps words still in use.
    // Not persisted here on purpose: the bump rides along with the next
    // content save rather than scheduling a write of its own.
    entry.lastUsed = Date.now();
    wordCache.set(japanese, entry);
    return entry;
  }
  return null;
}

/**
 * Find all known words in a text string, longest match first.
 *
 * Candidates are found by probing substrings of `text` against the cache, not
 * by scanning the whole cache against `text`. Cost is O(text.length x
 * maxKeyLen) hash lookups — independent of how many words are cached, which
 * matters because this runs once per text node during a highlight pass.
 *
 * Resolution is unchanged: longest words claim their span first, and a
 * candidate overlapping an already-claimed position is dropped. Where two
 * *different* words of equal length overlap, the earlier position now wins;
 * previously the winner was whichever happened to be learned first, which
 * varied per user and was not reproducible.
 *
 * @param {string} text - Text to scan for known words
 * @returns {Array<{word: string, start: number, end: number, data: Object}>}
 */
export function getCachedWords(text) {
  if (!text || wordCache.size === 0 || maxKeyLen === 0) return [];

  // Collect every (position, cached word) pair present in the text.
  const candidates = [];
  for (let i = 0; i < text.length; i++) {
    const limit = Math.min(maxKeyLen, text.length - i);
    for (let len = limit; len > 0; len--) {
      const slice = text.slice(i, i + len);
      if (wordCache.has(slice) && isMatchableKey(slice)) {
        candidates.push({ word: slice, start: i });
      }
    }
  }
  if (candidates.length === 0) return [];

  // Longest first, then leftmost — the greedy order the resolution below wants.
  candidates.sort((a, b) => (b.word.length - a.word.length) || (a.start - b.start));

  const claimed = new Uint8Array(text.length);
  const matches = [];

  for (const { word, start } of candidates) {
    const end = start + word.length;

    let overlaps = false;
    for (let i = start; i < end; i++) {
      if (claimed[i]) { overlaps = true; break; }
    }
    if (overlaps) continue;

    for (let i = start; i < end; i++) claimed[i] = 1;

    const data = wordCache.get(word);
    matches.push({
      word,
      start,
      end,
      data: {
        japanese: word,
        reading: data.reading,
        romaji: data.romaji,
        english: data.english,
        type: data.type
      }
    });
  }

  // Sort by position for proper rendering
  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Return cached words in the shape paintWordColoring / buildWordBoundaries expect
 * ({japanese, reading, romaji, english, type}), ordered by appearance in `text`.
 * Lets Meet's minimalistic mode pre-paint known words before the Gemini call.
 * @param {string} text
 * @returns {Array<{japanese: string, reading: string, romaji: string, english: string, type: string}>}
 */
export function getCachedWordBreakdown(text) {
  return getCachedWords(text).map(m => m.data);
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
    // Dropping the longest key would leave maxKeyLen too high: still correct,
    // but it costs wasted probes on every lookup until the next load.
    recomputeMaxKeyLen();
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
