/**
 * frequency-store: migration, merge correctness, and write amplification.
 *
 * The store was one `wordFrequencyData` blob that every save read and rewrote
 * in full. It is now sharded, so a save touches only the shards its words land
 * in. These tests pin that the counts are still correct, that an existing blob
 * migrates without loss, and that a small update no longer rewrites everything.
 *
 * Run: node tests/frequency-store.node.test.mjs
 */

// Minimal chrome.storage.local stand-in that records traffic.
function makeFakeStorage() {
  const data = new Map();
  const stats = { gets: 0, sets: 0, keysRead: 0, keysWritten: 0, bytesWritten: 0 };

  return {
    stats,
    dump: () => data,
    local: {
      get(keys, cb) {
        stats.gets++;
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) {
          stats.keysRead++;
          if (data.has(k)) out[k] = structuredClone(data.get(k));
        }
        cb(out);
      },
      set(items, cb) {
        stats.sets++;
        for (const [k, v] of Object.entries(items)) {
          stats.keysWritten++;
          stats.bytesWritten += JSON.stringify(v).length;
          data.set(k, structuredClone(v));
        }
        cb?.();
      },
      remove(keys, cb) {
        for (const k of (Array.isArray(keys) ? keys : [keys])) data.delete(k);
        cb?.();
      }
    }
  };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}

function wordEntry(japanese, type, count, ts) {
  return {
    japanese, reading: japanese + 'よみ', romaji: 'romaji', english: 'gloss',
    type, count, firstSeen: ts, lastSeen: ts
  };
}

// Fresh module instance per scenario (the migration promise is memoized).
async function freshStore(storage) {
  globalThis.chrome = { storage: storage.local ? { local: storage.local } : storage, runtime: {} };
  const url = new URL('../src/content/core/frequency-store.js', import.meta.url);
  return import(`${url.href}?t=${Math.random()}`);
}

// ------------------------------------------------------------------- counting

console.log('counts merge correctly across saves:');
{
  const storage = makeFakeStorage();
  const store = await freshStore(storage);

  const now = 1_700_000_000_000;
  await store.mergeWordCounts(new Map([
    ['会議|noun', wordEntry('会議', 'noun', 2, now)],
    ['です|copula', wordEntry('です', 'copula', 5, now)],
  ]));
  await store.mergeWordCounts(new Map([
    ['会議|noun', wordEntry('会議', 'noun', 3, now + 1000)],
    ['日本|noun', wordEntry('日本', 'noun', 1, now + 1000)],
  ]));

  const all = await store.readAllFrequency();
  check('existing word accumulates', all.words['会議|noun']?.count === 5,
    `got ${all.words['会議|noun']?.count}`);
  check('untouched word keeps its count', all.words['です|copula']?.count === 5);
  check('new word is added', all.words['日本|noun']?.count === 1);
  check('uniqueWords is 3', all.uniqueWords === 3, `got ${all.uniqueWords}`);
  check('totalWords is 11', all.totalWords === 11, `got ${all.totalWords}`);
  check('lastSeen advances', all.words['会議|noun'].lastSeen === now + 1000);
  check('firstSeen is preserved', all.words['会議|noun'].firstSeen === now);
}

// ------------------------------------------------------------------ migration

console.log('a pre-shard blob migrates without loss:');
{
  const storage = makeFakeStorage();
  const now = 1_700_000_000_000;
  const legacyWords = {};
  let expectedTotal = 0;
  for (let i = 0; i < 500; i++) {
    const count = (i % 7) + 1;
    legacyWords[`語${i}|noun`] = wordEntry(`語${i}`, 'noun', count, now);
    expectedTotal += count;
  }
  storage.dump().set('wordFrequencyData', {
    version: 1, lastUpdated: now, totalWords: expectedTotal, uniqueWords: 500, words: legacyWords
  });

  const store = await freshStore(storage);
  const all = await store.readAllFrequency();

  check('every word survives', Object.keys(all.words).length === 500,
    `got ${Object.keys(all.words).length}`);
  check('totals survive', all.totalWords === expectedTotal, `got ${all.totalWords}`);
  check('a sampled word is intact',
    all.words['語123|noun']?.japanese === '語123' && all.words['語123|noun']?.count === (123 % 7) + 1);
  check('legacy key is retained as a fallback', storage.dump().has('wordFrequencyData'));

  // Migrating twice must not double anything.
  const store2 = await freshStore(storage);
  const again = await store2.readAllFrequency();
  check('re-migration is idempotent',
    again.totalWords === expectedTotal && Object.keys(again.words).length === 500,
    `got total ${again.totalWords}, unique ${Object.keys(again.words).length}`);
}

// -------------------------------------------------------- write amplification

console.log('a small update no longer rewrites the whole corpus:');
{
  const storage = makeFakeStorage();
  const now = 1_700_000_000_000;
  const legacyWords = {};
  for (let i = 0; i < 20000; i++) legacyWords[`語${i}|noun`] = wordEntry(`語${i}`, 'noun', 1, now);
  storage.dump().set('wordFrequencyData', {
    version: 1, lastUpdated: now, totalWords: 20000, uniqueWords: 20000, words: legacyWords
  });

  const store = await freshStore(storage);
  await store.readAllFrequency(); // force migration

  const blobBytes = JSON.stringify(legacyWords).length;

  const before = { ...storage.stats };
  await store.mergeWordCounts(new Map([
    ['会議|noun', wordEntry('会議', 'noun', 1, now)],
    ['です|copula', wordEntry('です', 'copula', 1, now)],
  ]));
  const written = storage.stats.bytesWritten - before.bytesWritten;

  const ratio = written / blobBytes;
  console.log(`       corpus ${(blobBytes / 1048576).toFixed(2)} MB; ` +
    `a 2-word save wrote ${(written / 1024).toFixed(0)} KB (${(ratio * 100).toFixed(1)}% of the old blob)`);
  check('a 2-word save writes under 10% of the corpus', ratio < 0.10,
    `wrote ${(ratio * 100).toFixed(1)}%`);
  check('only the touched shards plus meta are written',
    storage.stats.keysWritten - before.keysWritten <= 3,
    `${storage.stats.keysWritten - before.keysWritten} keys`);
}

// ------------------------------------------------------------------- backfill

console.log('backfill adds only missing words:');
{
  const storage = makeFakeStorage();
  const store = await freshStore(storage);
  const now = 1_700_000_000_000;

  await store.mergeWordCounts(new Map([['会議|noun', wordEntry('会議', 'noun', 4, now)]]));
  const added = await store.addMissingWords(new Map([
    ['会議|noun', wordEntry('会議', 'noun', 1, now)],   // already present
    ['新語|noun', wordEntry('新語', 'noun', 1, now)],   // new
  ]));

  const all = await store.readAllFrequency();
  check('only the new word is added', added === 1, `added ${added}`);
  check('existing count is not clobbered', all.words['会議|noun'].count === 4,
    `got ${all.words['会議|noun'].count}`);
  check('unique count reflects the addition', all.uniqueWords === 2, `got ${all.uniqueWords}`);
}

console.log(failures === 0 ? '\nAll frequency-store tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
