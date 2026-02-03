import { debugLog } from '../core/debug.js';
import {
  FREQUENCY_SAVE_DEBOUNCE_MS,
  frequencySaveTimeout,
  setFrequencySaveTimeout,
  pendingFrequencyUpdates,
  countedContentKeys
} from '../core/state.js';

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

  // Mark as counted
  countedContentKeys.add(contentKey);

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
 * Save accumulated frequency updates to chrome.storage.local
 */
export async function saveFrequencyUpdates() {
  if (pendingFrequencyUpdates.size === 0) return;

  const updates = new Map(pendingFrequencyUpdates);
  pendingFrequencyUpdates.clear();

  try {
    // Load existing data
    const result = await new Promise(resolve => {
      chrome.storage.local.get(['wordFrequencyData'], resolve);
    });

    const data = result.wordFrequencyData || {
      version: 1,
      lastUpdated: Date.now(),
      totalWords: 0,
      uniqueWords: 0,
      words: {}
    };

    // Merge updates
    let newWordsAdded = 0;
    let totalCountAdded = 0;

    for (const [key, update] of updates) {
      if (data.words[key]) {
        // Update existing word
        data.words[key].count += update.count;
        data.words[key].lastSeen = update.lastSeen;
        totalCountAdded += update.count;
      } else {
        // Add new word
        data.words[key] = update;
        newWordsAdded++;
        totalCountAdded += update.count;
      }
    }

    // Update totals
    data.totalWords += totalCountAdded;
    data.uniqueWords = Object.keys(data.words).length;
    data.lastUpdated = Date.now();

    // Save back to storage
    await new Promise(resolve => {
      chrome.storage.local.set({ wordFrequencyData: data }, resolve);
    });

    debugLog('FREQ', `Saved: +${totalCountAdded} total, +${newWordsAdded} unique (${data.uniqueWords} total unique)`);
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
