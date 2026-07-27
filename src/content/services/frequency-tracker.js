import { debugLog } from '../core/debug.js';
import {
  FREQUENCY_SAVE_DEBOUNCE_MS,
  frequencySaveTimeout,
  setFrequencySaveTimeout,
  pendingFrequencyUpdates,
  countedContentKeys,
  rememberCountedContentKey
} from '../core/state.js';
import { mergeWordCounts } from '../core/frequency-store.js';

/**
 * Record word frequencies from breakdown data
 * @param {Array} words - Words array from breakdown data
 * @param {string} contentKey - Unique key for this translation
 */
export function recordWordFrequencies(words, contentKey) {
  // Skip if already counted this translation
  if (countedContentKeys.has(contentKey)) {
    debugLog('FREQ', `Already counted: ${contentKey.slice(0, 30)}`);
    return;
  }

  // Mark as counted (bounded — see rememberCountedContentKey)
  rememberCountedContentKey(contentKey);

  // Accumulate updates for each word
  const now = Date.now();
  for (const word of words) {
    const key = `${word.japanese}|${word.type}`;

    if (pendingFrequencyUpdates.has(key)) {
      // Increment existing pending update
      const existing = pendingFrequencyUpdates.get(key);
      existing.count++;
      existing.lastSeen = now;
    } else {
      // New word or first occurrence in this batch
      pendingFrequencyUpdates.set(key, {
        japanese: word.japanese,
        reading: word.reading || '',
        romaji: word.romaji,
        english: word.english,
        type: word.type,
        count: 1,
        firstSeen: now,
        lastSeen: now
      });
    }
  }

  debugLog('FREQ', `Queued ${words.length} words from ${contentKey.slice(0, 30)}`);

  // Debounce the save
  if (frequencySaveTimeout) {
    clearTimeout(frequencySaveTimeout);
  }

  setFrequencySaveTimeout(setTimeout(() => {
    saveFrequencyUpdates();
  }, FREQUENCY_SAVE_DEBOUNCE_MS));
}

/**
 * Persist accumulated frequency updates.
 *
 * Cost is proportional to the size of this batch, not to the whole corpus:
 * mergeWordCounts only reads and rewrites the shards the batch lands in.
 */
export async function saveFrequencyUpdates() {
  if (pendingFrequencyUpdates.size === 0) return;

  const updates = new Map(pendingFrequencyUpdates);
  pendingFrequencyUpdates.clear();

  try {
    const { newWords, addedCount } = await mergeWordCounts(updates);
    debugLog('FREQ', `Saved: +${addedCount} total, +${newWords} unique`);
  } catch (error) {
    debugLog('FREQ', 'Save error:', error.message);
    // Re-queue failed updates for next attempt
    for (const [key, update] of updates) {
      if (!pendingFrequencyUpdates.has(key)) {
        pendingFrequencyUpdates.set(key, update);
      }
    }
  }
}

// A meeting can run for hours, and the counts are a running total — losing the
// last few seconds of them on a crash costs nothing. Flush on the way out so an
// ordinary tab close or navigation still persists the tail.
if (typeof document !== 'undefined') {
  const flush = () => {
    if (frequencySaveTimeout) clearTimeout(frequencySaveTimeout);
    saveFrequencyUpdates();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
