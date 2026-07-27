/**
 * Sharded persistence for word frequency data.
 *
 * The counts used to live in one `wordFrequencyData` object that every save
 * read, merged and wrote back in full. Nothing prunes it, so the blob grows for
 * the life of the profile and each save cost O(all vocabulary ever seen) — a
 * few hundred saves an hour during a meeting, each a full JSON round trip plus
 * two structured clones and a disk write in the browser process. That is why
 * the extension felt slower the longer it had been used.
 *
 * Words are now spread over SHARD_COUNT keys. A save touches only the shards
 * whose words actually changed — typically one or two — so the cost tracks the
 * size of the update, not the size of the corpus. Running totals live in a
 * small meta record so no reader has to sum the whole set.
 *
 * chrome.storage.local rather than IndexedDB on purpose: this data is written
 * from content scripts and read from extension pages, and a content script's
 * IndexedDB belongs to the *host page's* origin, so the two would never see the
 * same database. chrome.storage is shared across both.
 */

const SHARD_COUNT = 32;
const SHARD_PREFIX = 'wfreq:';
const META_KEY = 'wfreqMeta';
const LEGACY_KEY = 'wordFrequencyData';
const SCHEMA_VERSION = 2;

const SHARD_KEYS = Array.from({ length: SHARD_COUNT }, (_, i) => `${SHARD_PREFIX}${i}`);

/** FNV-1a — cheap, and spreads `japanese|type` keys evenly across shards. */
function shardKeyFor(wordKey) {
  let h = 0x811c9dc5;
  for (let i = 0; i < wordKey.length; i++) {
    h ^= wordKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return SHARD_KEYS[(h >>> 0) % SHARD_COUNT];
}

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function emptyMeta() {
  return { version: SCHEMA_VERSION, totalWords: 0, uniqueWords: 0, lastUpdated: Date.now() };
}

/**
 * Move a pre-shard `wordFrequencyData` blob into shards, once.
 *
 * Idempotent: it writes absolute entries rather than increments, so two frames
 * racing to migrate produce the same result. The legacy key is deliberately
 * left in place — a release that can still read it is a cheap safety net, and
 * it is only a few MB.
 */
let migration = null;
export function ensureMigrated() {
  if (!migration) migration = migrate();
  return migration;
}

async function migrate() {
  const existing = await storageGet([META_KEY, LEGACY_KEY]);
  if (existing[META_KEY]?.version === SCHEMA_VERSION) return;

  const legacy = existing[LEGACY_KEY];
  const words = legacy?.words;
  if (!words || typeof words !== 'object') {
    await storageSet({ [META_KEY]: emptyMeta() });
    return;
  }

  const shards = {};
  let uniqueWords = 0;
  let totalWords = 0;

  for (const [wordKey, entry] of Object.entries(words)) {
    const shard = shardKeyFor(wordKey);
    (shards[shard] ||= {})[wordKey] = entry;
    uniqueWords++;
    totalWords += entry.count || 0;
  }

  await storageSet({
    ...shards,
    [META_KEY]: { version: SCHEMA_VERSION, totalWords, uniqueWords, lastUpdated: Date.now() }
  });
}

/**
 * Fold a batch of counted words into the store.
 *
 * @param {Map<string, {japanese: string, reading: string, romaji: string,
 *   english: string, type: string, count: number, firstSeen: number,
 *   lastSeen: number}>} updates - keyed by `${japanese}|${type}`
 * @returns {Promise<{newWords: number, addedCount: number}>}
 */
export async function mergeWordCounts(updates) {
  if (!updates || updates.size === 0) return { newWords: 0, addedCount: 0 };
  await ensureMigrated();

  // Only the shards this batch actually lands in get read and rewritten.
  const touched = new Map(); // shardKey -> Map<wordKey, update>
  for (const [wordKey, update] of updates) {
    const shard = shardKeyFor(wordKey);
    let bucket = touched.get(shard);
    if (!bucket) touched.set(shard, bucket = new Map());
    bucket.set(wordKey, update);
  }

  const shardKeys = [...touched.keys()];
  const stored = await storageGet([...shardKeys, META_KEY]);
  const meta = stored[META_KEY] || emptyMeta();

  const write = {};
  let newWords = 0;
  let addedCount = 0;

  for (const [shardKey, bucket] of touched) {
    const shard = stored[shardKey] || {};
    for (const [wordKey, update] of bucket) {
      const existing = shard[wordKey];
      if (existing) {
        existing.count += update.count;
        existing.lastSeen = update.lastSeen;
        // Backfill glosses learned since the word was first counted.
        if (!existing.english && update.english) existing.english = update.english;
        if (!existing.reading && update.reading) existing.reading = update.reading;
      } else {
        shard[wordKey] = update;
        newWords++;
      }
      addedCount += update.count;
    }
    write[shardKey] = shard;
  }

  meta.version = SCHEMA_VERSION;
  meta.totalWords += addedCount;
  meta.uniqueWords += newWords;
  meta.lastUpdated = Date.now();
  write[META_KEY] = meta;

  await storageSet(write);
  return { newWords, addedCount };
}

/**
 * Insert words that are not already present, leaving existing counts alone.
 * Used by the dashboard's backfill from the word cache.
 * @param {Map<string, Object>} entries - keyed by `${japanese}|${type}`
 * @returns {Promise<number>} how many were actually added
 */
export async function addMissingWords(entries) {
  if (!entries || entries.size === 0) return 0;
  await ensureMigrated();

  const touched = new Map();
  for (const [wordKey, entry] of entries) {
    const shard = shardKeyFor(wordKey);
    let bucket = touched.get(shard);
    if (!bucket) touched.set(shard, bucket = new Map());
    bucket.set(wordKey, entry);
  }

  const shardKeys = [...touched.keys()];
  const stored = await storageGet([...shardKeys, META_KEY]);
  const meta = stored[META_KEY] || emptyMeta();

  const write = {};
  let added = 0;

  for (const [shardKey, bucket] of touched) {
    const shard = stored[shardKey] || {};
    let shardChanged = false;
    for (const [wordKey, entry] of bucket) {
      if (shard[wordKey]) continue;
      shard[wordKey] = entry;
      meta.totalWords += entry.count || 0;
      added++;
      shardChanged = true;
    }
    if (shardChanged) write[shardKey] = shard;
  }

  if (added === 0) return 0;

  meta.version = SCHEMA_VERSION;
  meta.uniqueWords += added;
  meta.lastUpdated = Date.now();
  write[META_KEY] = meta;

  await storageSet(write);
  return added;
}

/**
 * Read the whole corpus, in the shape the dashboard renders.
 * Only the frequency page calls this; the hot write path never does.
 * @returns {Promise<{version: number, lastUpdated: number, totalWords: number,
 *   uniqueWords: number, words: Object}>}
 */
export async function readAllFrequency() {
  await ensureMigrated();
  const stored = await storageGet([...SHARD_KEYS, META_KEY]);
  const meta = stored[META_KEY] || emptyMeta();

  const words = {};
  for (const shardKey of SHARD_KEYS) {
    const shard = stored[shardKey];
    if (!shard) continue;
    Object.assign(words, shard);
  }

  return {
    version: SCHEMA_VERSION,
    lastUpdated: meta.lastUpdated,
    totalWords: meta.totalWords,
    uniqueWords: Object.keys(words).length,
    words
  };
}

/** Drop every shard, the meta record and the legacy blob. */
export async function clearFrequency() {
  await new Promise(resolve =>
    chrome.storage.local.remove([...SHARD_KEYS, META_KEY, LEGACY_KEY], resolve));
  migration = null;
}
