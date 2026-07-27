/**
 * getCachedWords: equivalence + cost tests.
 *
 * The lookup was rewritten from "sort every cache key by length, then scan the
 * text for each" to "probe substrings of the text against the cache", so cost
 * no longer tracks cache size.
 *
 * Resolution stays longest-match-first. The one difference: when two different
 * words of equal length overlap, the leftmost now wins. Previously the winner
 * was whichever word had been learned first, so identical cache contents gave
 * different highlighting depending on learning history. These tests pin the new
 * deterministic contract, show it agrees with the old behaviour on realistic
 * (kuromoji-shaped) vocabularies, and bound the difference elsewhere.
 *
 * Run: node tests/word-cache.node.test.mjs
 */

const JAPANESE_CHAR_RE = /[぀-ゟ゠-ヿ一-龯]/;

/** The original implementation, kept verbatim as the reference oracle. */
function getCachedWordsOld(wordCache, text) {
  if (!text || wordCache.size === 0) return [];

  const matches = [];
  const sortedWords = Array.from(wordCache.keys())
    .filter(w => w.length > 0 && JAPANESE_CHAR_RE.test(w))
    .sort((a, b) => b.length - a.length);

  const matched = new Set();

  for (const word of sortedWords) {
    let startIndex = 0;
    while (true) {
      const pos = text.indexOf(word, startIndex);
      if (pos === -1) break;

      let overlaps = false;
      for (let i = pos; i < pos + word.length; i++) {
        if (matched.has(i)) { overlaps = true; break; }
      }

      if (!overlaps) {
        for (let i = pos; i < pos + word.length; i++) matched.add(i);
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

  return matches.sort((a, b) => a.start - b.start);
}

/** The new implementation, mirroring src/content/core/word-cache.js. */
function makeNew(wordCache) {
  let maxKeyLen = 0;
  const isMatchableKey = (w) => w.length > 0 && JAPANESE_CHAR_RE.test(w);
  for (const w of wordCache.keys()) {
    if (isMatchableKey(w) && w.length > maxKeyLen) maxKeyLen = w.length;
  }

  return function getCachedWordsNew(text) {
    if (!text || wordCache.size === 0 || maxKeyLen === 0) return [];

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
        word, start, end,
        data: {
          japanese: word,
          reading: data.reading,
          romaji: data.romaji,
          english: data.english,
          type: data.type
        }
      });
    }

    return matches.sort((a, b) => a.start - b.start);
  };
}

function entry(word) {
  return { reading: word + 'r', romaji: 'r', english: 'e', type: 'noun', lastUsed: Date.now() };
}

function cacheOf(words) {
  const m = new Map();
  for (const w of words) m.set(w, entry(w));
  return m;
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------- equivalence

const CORPUS = [
  '今日の会議では新しいプロジェクトの進捗について話し合いました。',
  '日本語の勉強を毎日続けることが大切です。',
  'この機能はまだ実装されていませんが、来週リリースする予定です。',
  '東京から大阪まで新幹線で行きます。',
  'すみません、もう一度説明していただけますか。',
  'システムのパフォーマンスが低下している原因を調査中です。',
  '',
  'no japanese here at all',
  '会議',
];

const VOCAB = [
  '会議', '今日', '新しい', 'プロジェクト', '進捗', '話し合い', '日本', '日本語',
  '勉強', '毎日', '大切', '機能', '実装', '来週', 'リリース', '予定', '東京',
  '大阪', '新幹線', '説明', 'システム', 'パフォーマンス', '低下', '原因', '調査',
  '本', '語', '日', '会', '議', '大', '新', 'の', 'を', 'が', 'は',
];

console.log('equivalence on realistic corpus:');
{
  const cache = cacheOf(VOCAB);
  const fresh = makeNew(cache);
  let allMatch = true;
  for (const text of CORPUS) {
    const a = JSON.stringify(getCachedWordsOld(cache, text));
    const b = JSON.stringify(fresh(text));
    if (a !== b) {
      allMatch = false;
      console.log(`       text: ${text}\n       old: ${a}\n       new: ${b}`);
    }
  }
  check('old and new agree on every corpus sentence', allMatch);
}

// Where two DIFFERENT words of equal length overlap, the old winner was
// whichever was learned first — so the same cache contents produced different
// highlighting for different users, and re-learning a word could change it. The
// new rule is leftmost-longest, which is deterministic. These tests pin the new
// contract and bound the difference rather than asserting byte-equality.

console.log('result no longer depends on cache insertion order:');
{
  let unstable = 0;
  let trials = 0;
  let seed = 777;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let trial = 0; trial < 200; trial++) {
    const text = CORPUS[Math.floor(rnd() * (CORPUS.length - 3))];
    if (!text) continue;
    const words = new Set();
    for (let k = 0; k < 25; k++) {
      const start = Math.floor(rnd() * text.length);
      const len = 1 + Math.floor(rnd() * 4);
      const w = text.slice(start, start + len);
      if (w.length > 0 && JAPANESE_CHAR_RE.test(w)) words.add(w);
    }
    if (words.size === 0) continue;
    trials++;

    const forward = [...words];
    const reversed = [...words].reverse();
    const a = JSON.stringify(makeNew(cacheOf(forward))(text));
    const b = JSON.stringify(makeNew(cacheOf(reversed))(text));
    if (a !== b) unstable++;

    // The old implementation is expected to be order-dependent; that is the
    // wart being removed, so it is not asserted here.
  }
  check(`${trials} vocabularies give the same result in any insertion order`, unstable === 0,
    unstable ? `${unstable} order-dependent results` : '');
}

console.log('coverage is never materially worse than the old resolution:');
{
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let covOld = 0, covNew = 0, trials = 0;
  const covered = (r) => r.reduce((s, m) => s + m.word.length, 0);

  for (let trial = 0; trial < 3000; trial++) {
    const text = CORPUS[Math.floor(rnd() * (CORPUS.length - 3))];
    if (!text) continue;
    const words = new Set();
    for (let k = 0; k < 25; k++) {
      const start = Math.floor(rnd() * text.length);
      const len = 1 + Math.floor(rnd() * 4);
      const w = text.slice(start, start + len);
      if (w.length > 0 && JAPANESE_CHAR_RE.test(w)) words.add(w);
    }
    if (words.size === 0) continue;
    trials++;
    const cache = cacheOf([...words]);
    covOld += covered(getCachedWordsOld(cache, text));
    covNew += covered(makeNew(cache)(text));
  }
  const delta = (covNew / covOld - 1) * 100;
  console.log(`       ${trials} trials: old covered ${covOld} chars, new ${covNew} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%)`);
  check('new resolution covers at least as many characters overall', covNew >= covOld);
}

console.log('every returned match is a genuine cache hit at its stated offset:');
{
  const cache = cacheOf(VOCAB);
  const fn = makeNew(cache);
  let bad = 0;
  let prevEnd;
  for (const text of CORPUS) {
    prevEnd = 0;
    for (const m of fn(text)) {
      if (text.slice(m.start, m.end) !== m.word) bad++;
      if (!cache.has(m.word)) bad++;
      if (m.start < prevEnd) bad++;   // spans must not overlap
      prevEnd = m.end;
    }
  }
  check('matches are real, correctly offset and non-overlapping', bad === 0, `${bad} violations`);
}

console.log('leftmost-longest tiebreak, pinned:');
{
  // text: 日(0) 本(1) 語(2) — "日本" and "本語" are both length 2 and overlap.
  const got = makeNew(cacheOf(['本語', '日本']))('日本語'); // "本語" inserted first
  check('leftmost wins regardless of insertion order',
    got.length === 1 && got[0].word === '日本' && got[0].start === 0,
    JSON.stringify(got));
}

// ------------------------------------------------------------------ flat cost

console.log('cost is independent of cache size:');
{
  const JP = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ漢字日本語会議';
  const text = '今日の会議では新しいプロジェクトの進捗について話し合いました。';
  const timings = [];

  for (const n of [1000, 5000, 20000, 50000]) {
    const m = new Map();
    for (const w of VOCAB) m.set(w, entry(w));
    for (let i = 0; i < n; i++) {
      let w = '';
      const len = 1 + (i % 4);
      for (let j = 0; j < len; j++) w += JP[(i * 7 + j * 13) % JP.length];
      m.set(w + JP[i % JP.length], entry(w));
    }
    const fn = makeNew(m);
    fn(text); // warm

    const R = 200;
    const t0 = process.hrtime.bigint();
    for (let r = 0; r < R; r++) fn(text);
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6 / R;
    timings.push({ n, ms });
    console.log(`       cache=${String(n).padStart(6)}  ${ms.toFixed(4)} ms/call`);
  }

  const smallest = timings[0].ms;
  const largest = timings[timings.length - 1].ms;
  const ratio = largest / smallest;
  check(`50k costs no more than 2x 1k (ratio ${ratio.toFixed(2)})`, ratio < 2.0);
}

console.log(failures === 0 ? '\nAll word-cache tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
