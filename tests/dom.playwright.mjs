#!/usr/bin/env node
// DOM-level tests for the universal colorizer's block detection, text
// assembly, and token painting (block-walker.js, auto-lite-core.js,
// auto-token-mapper.js). These modules are pure DOM ES modules (no chrome.*),
// so they load straight into headless Chromium over a local http server —
// ES-module imports over file:// are CORS-blocked, and block detection needs
// a real getComputedStyle. Analyzer words are synthesized here; the kuromoji
// pipeline itself is covered by test:nlp.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, info) { console.log(`  ✗ ${n}`); if (info) console.log(`     ${info}`); fail++; }
function assertEq(n, a, e) {
  JSON.stringify(a) === JSON.stringify(e) ? ok(n) : bad(n, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(n, v) { v ? ok(n) : bad(n, `expected truthy, got ${JSON.stringify(v)}`); }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};
const server = createServer(async (req, res) => {
  try {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT)) throw new Error('traversal');
    res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
    res.end(await readFile(p));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message}`));

async function loadFixture() {
  await page.goto(`${BASE}/tests/fixtures/universal-dom.html`);
  await page.evaluate(async () => {
    window.bw = await import('/src/content/shared/block-walker.js');
    window.core = await import('/src/content/shared/auto-lite-core.js');
    window.mapper = await import('/src/content/utils/auto-token-mapper.js');
    // Chrome-free: debug.js guards its chrome.storage access, so the tooltip's
    // target test can be exercised on a plain page.
    window.tip = await import('/src/content/chat/word-tooltip.js');
    // Click-to-join. Chrome-free like the tooltip; metrics/index.js guards its
    // own chrome access, so importing it here is safe.
    window.isl = await import('/src/content/shared/word-island.js');
    // Meet's renderer is a separate innerHTML path, so it needs its own coverage.
    // Its only non-text import guards its chrome access.
    window.wr = await import('/src/content/shared/word-render.js');
  });
}

try {
  await loadFixture();

  // ---- T1: fake-furigana h2 resolves as one block; assembly is the clean sentence
  console.log('\nT1: wruby h2 is a single unit');
  const t1 = await page.evaluate(() => {
    const root = document.getElementById('t1');
    const blocks = bw.findJapaneseBlocks(root);
    const { assembled } = core.collectBlockTextNodes(
      document.getElementById('t1h'), bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    return { ids: blocks.map(b => b.id || b.tagName), assembled };
  });
  assertEq('only the h2 is collected', t1.ids, ['t1h']);
  assertEq('assembled text is the sentence without readings', t1.assembled, '次の言い方で正しいものはどれか。');

  // ---- T1b: three-segment word (言い方 = wruby kanji + okurigana + wruby kanji)
  console.log('\nT1b: 言い方 paints as three segments');
  const t1b = await page.evaluate(() => {
    const el = document.getElementById('t1h');
    const W = (japanese, type) => ({ japanese, reading: '', romaji: '', english: 'x', type });
    const painted = core.paintBlockTokens(el, '次の言い方で正しいものはどれか。',
      [W('次', 'noun'), W('の', 'particle'), W('言い方', 'noun'), W('で', 'particle'),
       W('正しい', 'adjective'), W('もの', 'noun'), W('は', 'particle'), W('どれ', 'noun'), W('か', 'particle')],
      { marker: 'gcwbUniv', excludeTags: bw.SKIP_SUBTREE_TAGS, stopAtNestedBlocks: true });
    const iikata = [...el.querySelectorAll('.gcwb-auto-word')].filter(s => s.dataset.word === '言い方');
    return {
      painted,
      texts: iikata.map(s => s.textContent),
      inWruby: iikata.map(s => !!s.closest('.wruby')),
      supsPainted: el.querySelectorAll('sup .gcwb-auto-word').length,
    };
  });
  assertEq('painted', t1b.painted, true);
  assertEq('three segments in document order', t1b.texts, ['言', 'い', '方']);
  assertEq('kanji segments sit inside their wruby wrappers', t1b.inWruby, [true, false, true]);
  assertEq('no sup painted', t1b.supsPainted, 0);

  // ---- T2: parent and nested child both collected
  console.log('\nT2: parent + nested p coexist');
  const t2 = await page.evaluate(() => {
    const root = document.getElementById('t2');
    return bw.findJapaneseBlocks(root).map(b => b.id).sort();
  });
  assertEq('parent div and child p both returned', t2, ['t2', 't2p']);

  // ---- T3: computed display for generic tags, semantic override for li
  console.log('\nT3: computed display beats tag; semantic tags always block');
  const t3 = await page.evaluate(() => {
    const root = document.getElementById('t3');
    return bw.findJapaneseBlocks(root).map(b => b.id).sort();
  });
  assertEq('display:block span + inline li are blocks; inline div is not', t3, ['t3', 't3li', 't3s']);

  // ---- T4: SUP/SUB excluded
  console.log('\nT4: sup/sub never analyzed');
  const t4 = await page.evaluate(() => {
    const a = bw.findJapaneseBlocks(document.getElementById('t4a'));
    const { assembled } = core.collectBlockTextNodes(
      document.getElementById('t4b'), bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    return { aCount: a.length, assembled };
  });
  assertEq('sup-only Japanese yields no blocks', t4.aCount, 0);
  assertEq('assembly drops sup/sub text', t4.assembled, 'これはテストです');

  // ---- T5: nested-stop seams vs default (Redmine) assembly
  console.log('\nT5: seams under stopAtNestedBlocks; default path byte-identical');
  const t5 = await page.evaluate(() => {
    const el = document.getElementById('t2');
    const univ = core.collectBlockTextNodes(el, bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    const redmine = core.collectBlockTextNodes(el, new Set(['PRE', 'CODE', 'IMG', 'OBJECT']));
    const seamIdx = univ.assembled.indexOf('\n');
    const seamCovered = univ.ranges.some(r => r.start <= seamIdx && seamIdx < r.end);
    return { univ: univ.assembled, seamIdx, seamCovered, redmine: redmine.assembled };
  });
  assertEq('universal assembly has a seam', t5.univ, '直接のテキスト\nあとのテキスト');
  assertTrue('seam index exists', t5.seamIdx > 0);
  assertEq('no range covers the seam', t5.seamCovered, false);
  assertEq('default assembly unchanged', t5.redmine, '直接のテキスト段落の中の日本語あとのテキスト');

  // ---- T6: straddle across the wruby boundary (the marked-but-black killer)
  console.log('\nT6: 合う straddling wruby paints as two segments');
  const t6 = await page.evaluate(() => {
    const el = document.getElementById('t6');
    const painted = core.paintBlockTokens(el, '合う',
      [{ japanese: '合う', reading: 'あう', romaji: 'au', english: 'to match; to fit', type: 'verb' }],
      { marker: 'gcwbUniv', excludeTags: bw.SKIP_SUBTREE_TAGS, stopAtNestedBlocks: true });
    const spans = [...el.querySelectorAll('.gcwb-auto-word')];
    return {
      painted,
      words: spans.map(s => s.dataset.word),
      texts: spans.map(s => s.textContent),
      supPainted: !!el.querySelector('sup .gcwb-auto-word'),
      supText: el.querySelector('sup').textContent,
      marker: el.dataset.gcwbUniv,
      visible: el.textContent,
    };
  });
  assertEq('painted', t6.painted, true);
  assertEq('both segments carry the full word', t6.words, ['合う', '合う']);
  assertEq('segment texts are the node slices', t6.texts, ['合', 'う']);
  assertEq('sup untouched', t6.supPainted, false);
  assertEq('sup reading intact', t6.supText, 'あ');
  assertEq('marker set', t6.marker, '1');
  assertEq('no character loss or duplication', t6.visible, '合あう');

  // ---- T7: straddle across an inline <b>
  console.log('\nT7: 大切 straddling <b> paints; neighbors stay single spans');
  const t7 = await page.evaluate(() => {
    const el = document.getElementById('t7');
    const W = (japanese, type) => ({ japanese, reading: '', romaji: '', english: 'x', type });
    const painted = core.paintBlockTokens(el, 'これは大切です',
      [W('これ', 'noun'), W('は', 'particle'), W('大切', 'adjective'), W('です', 'copula')],
      { marker: 'gcwbUniv', excludeTags: bw.SKIP_SUBTREE_TAGS, stopAtNestedBlocks: true });
    const inB = el.querySelector('b .gcwb-auto-word');
    const taisetsu = [...el.querySelectorAll('.gcwb-auto-word')].filter(s => s.dataset.word === '大切');
    const kore = [...el.querySelectorAll('.gcwb-auto-word')].filter(s => s.dataset.word === 'これ');
    return {
      painted,
      bSegment: inB ? { word: inB.dataset.word, text: inB.textContent } : null,
      taisetsuTexts: taisetsu.map(s => s.textContent),
      koreCount: kore.length,
    };
  });
  assertEq('painted', t7.painted, true);
  assertEq('segment inside <b>', t7.bSegment, { word: '大切', text: '大' });
  assertEq('two segments for 大切', t7.taisetsuTexts, ['大', '切']);
  assertEq('これ stays one span', t7.koreCount, 1);

  // ---- T8: mapper word field + abutting-token separation
  console.log('\nT8: wrapJapaneseTokensInTextNode word field');
  const t8 = await page.evaluate(() => {
    const el = document.getElementById('t8');
    const before = el.textContent;
    const textNode = el.firstChild;
    mapper.wrapJapaneseTokensInTextNode(textNode, [
      { surface: 'ことば', word: '言葉', start: 0, end: 3, reading: 'ことば', romaji: 'kotoba', english: 'word', type: 'noun' },
      { surface: 'です', start: 3, end: 5, reading: '', romaji: 'desu', english: 'copula (to be)', type: 'copula' },
    ]);
    const spans = [...el.querySelectorAll('.gcwb-auto-word')];
    return {
      words: spans.map(s => s.dataset.word),
      texts: spans.map(s => s.textContent),
      before,
      joined: el.textContent,
      abut: spans.map(s => s.classList.contains('gcwb-abut')),
    };
  });
  assertEq('dataset.word uses t.word then falls back to surface', t8.words, ['言葉', 'です']);
  assertEq('visible text stays the node slices', t8.texts, ['ことば', 'です']);
  // Separation is a CSS margin now. Injecting a real space broke Ctrl+F across a
  // token boundary and put spaces into anything the user copied.
  assertEq('painting does not alter the page text', t8.joined, t8.before);
  assertEq('no separator character is inserted', t8.joined, 'ことばです');
  assertEq('the abutting token is marked for CSS spacing', t8.abut, [false, true]);

  // ---- T9: Redmine-shaped default path with translation boundary
  console.log('\nT9: default opts keep nested p in one unit; boundary span works');
  const t9 = await page.evaluate(() => {
    const el = document.getElementById('t9');
    const EX = new Set(['PRE', 'CODE', 'IMG', 'OBJECT']);
    const analyzerText = core.collectBlockTextNodes(el, EX).assembled;
    const W = (japanese, type) => ({ japanese, reading: '', romaji: '', english: 'x', type });
    const painted = core.paintBlockTokens(el, analyzerText,
      [W('最初', 'noun'), W('の', 'particle'), W('文', 'noun'), W('です', 'copula'),
       W('中', 'noun'), W('の', 'particle'), W('言葉', 'noun')],
      { marker: 'gcwbAutoLite', excludeTags: EX, translation: 'First sentence.' });
    const inP = el.querySelector('p .gcwb-auto-word');
    const boundary = el.querySelector('.gcwb-auto-boundary');
    return {
      painted,
      analyzerText,
      nestedPainted: inP ? inP.dataset.word : null,
      boundaryEnglish: boundary ? boundary.dataset.english : null,
      boundaryClause: boundary ? boundary.dataset.clause : null,
      dotCount: el.querySelectorAll('.gcwb-auto-boundary').length,
      marker: el.dataset.gcwbAutoLite,
    };
  });
  assertEq('default assembly spans nested p', t9.analyzerText, '最初の文です。中の言葉');
  assertEq('painted', t9.painted, true);
  assertEq('word inside nested p painted', t9.nestedPainted, '中');
  // The block holds two Japanese clauses, so the block translation is not
  // honestly either one and the dot ships empty, carrying its own clause for the
  // tooltip to resolve on hover.
  assertEq('boundary dot carries its own clause', t9.boundaryClause, '最初の文です。');
  assertEq('boundary dot is not seeded from the block translation', t9.boundaryEnglish, '');
  // 中の言葉 is unterminated but under MIN_SYNTHETIC_CLAUSE_CHARS, so no second dot.
  assertEq('short unterminated tail earns no synthetic dot', t9.dotCount, 1);
  assertEq('redmine marker set', t9.marker, '1');

  // ---- T10: drift safety
  console.log('\nT10: drift skips wrapping but still marks');
  const t10 = await page.evaluate(() => {
    const el = document.getElementById('t10');
    const painted = core.paintBlockTokens(el, 'まったく違うテキスト',
      [{ japanese: '違う', reading: '', romaji: '', english: 'x', type: 'verb' }],
      { marker: 'gcwbUniv', excludeTags: bw.SKIP_SUBTREE_TAGS, stopAtNestedBlocks: true });
    return { painted, spans: el.querySelectorAll('.gcwb-auto-word').length, marker: el.dataset.gcwbUniv };
  });
  assertEq('painted is false on drift', t10.painted, false);
  assertEq('nothing wrapped', t10.spans, 0);
  assertEq('marker still set', t10.marker, '1');

  // ---- T11: fallback word containing a seam is skipped
  console.log('\nT11: seam-containing surface skipped, later words still paint');
  const t11 = await page.evaluate(() => {
    const el = document.getElementById('t11');
    const { assembled } = core.collectBlockTextNodes(el, bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    const painted = core.paintBlockTokens(el, assembled,
      [{ japanese: assembled, reading: '', romaji: '', english: 'x', type: 'expression' },
       { japanese: '直接', reading: '', romaji: '', english: 'x', type: 'noun' }],
      { marker: 'gcwbUniv', excludeTags: bw.SKIP_SUBTREE_TAGS, stopAtNestedBlocks: true });
    const spans = [...el.querySelectorAll('.gcwb-auto-word')];
    return { assembled, painted, words: spans.map(s => s.dataset.word) };
  });
  assertTrue('assembled contains a seam', t11.assembled.includes('\n'));
  assertEq('painted', t11.painted, true);
  assertEq('only the clean word wrapped', t11.words, ['直接']);

  // ---- T12: display:none inline text excluded, no seam; hidden span owns its text
  console.log('\nT12: hidden inline text stays out of the visible unit');
  const t12 = await page.evaluate(() => {
    const el = document.getElementById('t12');
    const { assembled } = core.collectBlockTextNodes(el, bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    const blocks = bw.findJapaneseBlocks(el).map(b => b.id).sort();
    const painted = core.paintBlockTokens(el, assembled,
      [{ japanese: '合字', reading: 'ごうじ', romaji: 'gouji', english: 'ligature', type: 'noun' }],
      { marker: 'gcwbUniv', excludeTags: bw.SKIP_SUBTREE_TAGS, stopAtNestedBlocks: true });
    const spans = [...el.querySelectorAll('.gcwb-auto-word')];
    return {
      assembled,
      blocks,
      painted,
      words: spans.map(s => s.dataset.word),
      texts: spans.map(s => s.textContent),
      hiddenText: document.getElementById('t12h').textContent,
    };
  });
  assertEq('hidden reading dropped from assembly, no seam', t12.assembled, '合字');
  assertEq('hidden span owns its text as a separate unit', t12.blocks, ['t12', 't12h']);
  assertEq('painted', t12.painted, true);
  assertEq('visible word wraps around the hidden hole', t12.words, ['合字', '合字']);
  assertEq('segment texts', t12.texts, ['合', '字']);
  assertEq('hidden text untouched', t12.hiddenText, 'ごう');

  // ---- T13: <br> seams the unit
  console.log('\nT13: <br> is a seam');
  const t13 = await page.evaluate(() => {
    const { assembled, ranges } = core.collectBlockTextNodes(
      document.getElementById('t13'), bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    const seamIdx = assembled.indexOf('\n');
    return { assembled, seamCovered: ranges.some(r => r.start <= seamIdx && seamIdx < r.end) };
  });
  assertEq('br produces a seam', t13.assembled, '一行目のテキスト\n二行目のことば');
  assertEq('no range covers the br seam', t13.seamCovered, false);

  // ---- T14: vendor-prefixed inline display is not a block boundary
  console.log('\nT14: -webkit-inline-box is inline-level');
  const t14 = await page.evaluate(() => {
    const el = document.getElementById('t14');
    const { assembled } = core.collectBlockTextNodes(el, bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    return { assembled, spanIsBlock: bw.isBlockLevel(document.getElementById('t14s'), new Map()) };
  });
  assertEq('inline-box span does not seam the sentence', t14.assembled, 'これは大切です');
  assertEq('isBlockLevel treats -webkit-inline-box as inline', t14.spanIsBlock, false);

  // ---- T15: readability halo — painted words carry the white text-shadow.
  // Runs last: it injects content.css, which would perturb the computed-style
  // block-detection assertions of the earlier tests. Fresh fixture first.
  console.log('\nT15: painted words carry the white readability halo');
  await loadFixture();
  await page.addStyleTag({ path: path.join(ROOT, 'src/content/content.css') });
  const t15 = await page.evaluate(() => {
    const el = document.getElementById('t1h');
    const W = (japanese, type) => ({ japanese, reading: '', romaji: '', english: 'x', type });
    core.paintBlockTokens(el, '次の言い方で正しいものはどれか。',
      [W('次', 'noun'), W('の', 'particle'), W('言い方', 'noun'), W('で', 'particle'),
       W('正しい', 'adjective'), W('もの', 'noun'), W('は', 'particle'), W('どれ', 'noun'), W('か', 'particle')],
      { marker: 'gcwbUniv', excludeTags: bw.SKIP_SUBTREE_TAGS, stopAtNestedBlocks: true });
    const span = el.querySelector('.gcwb-auto-word');
    return { shadow: span ? getComputedStyle(span).textShadow : null };
  });
  assertTrue('painted word has a text-shadow', !!t15.shadow && t15.shadow !== 'none');
  assertTrue('halo is white', !!t15.shadow && t15.shadow.includes('255, 255, 255'));

  // ---- T16: native ruby base + reading use the word's POS color.
  console.log('\nT16: native ruby base and reading colorize together');
  const t16 = await page.evaluate(() => {
    const el = document.getElementById('t16p');
    const blocks = bw.findJapaneseBlocks(document.getElementById('t16')).map(b => b.id);
    const { assembled } = core.collectBlockTextNodes(
      el, bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    const W = (japanese, type) => ({ japanese, reading: '', romaji: '', english: 'x', type });
    const painted = core.paintBlockTokens(el, assembled,
      [W('雨', 'noun'), W('も', 'particle')],
      {
        marker: 'gcwbUniv',
        excludeTags: bw.SKIP_SUBTREE_TAGS,
        stopAtNestedBlocks: true,
        decorateNativeRuby: true,
      });
    const ruby = document.getElementById('t16rain');
    const base = ruby.querySelector(':scope > .gcwb-auto-word');
    const reading = ruby.querySelector(':scope > rt');
    const particle = document.querySelector('#t16mo > .gcwb-auto-word');
    return {
      blocks,
      assembled,
      painted,
      baseWrapped: !!base,
      baseColor: base ? getComputedStyle(base).color : getComputedStyle(ruby).color,
      readingText: reading.textContent,
      readingColor: getComputedStyle(reading).color,
      readingWrapped: reading.matches('.gcwb-auto-word') || !!reading.querySelector('.gcwb-auto-word'),
      readingMarker: reading.classList.contains('gcwb-ruby-reading'),
      siteClassPreserved: reading.classList.contains('site-reading'),
      particleColor: particle ? getComputedStyle(particle).color : null,
    };
  });
  assertEq('native ruby resolves to its paragraph block', t16.blocks, ['t16p']);
  assertEq('analyzer input includes base but excludes reading', t16.assembled, '雨も');
  assertEq('painted', t16.painted, true);
  assertEq('base is wrapped', t16.baseWrapped, true);
  assertEq('base is noun blue', t16.baseColor, 'rgb(66, 133, 244)');
  assertEq('reading text is preserved', t16.readingText, 'あめ');
  assertEq('reading is noun blue', t16.readingColor, 'rgb(66, 133, 244)');
  assertEq('reading is presentation-only', t16.readingWrapped, false);
  assertEq('reading carries its dedicated marker', t16.readingMarker, true);
  assertEq('reading preserves its site-owned class', t16.siteClassPreserved, true);
  assertEq('adjacent particle still paints red', t16.particleColor, 'rgb(234, 67, 53)');

  // ---- T17: explicit rb/rt pairs keep their own POS colors.
  console.log('\nT17: explicit ruby-base pairs color their associated readings');
  const t17 = await page.evaluate(() => {
    const el = document.getElementById('t17');
    const { assembled } = core.collectBlockTextNodes(
      el, bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    const W = (japanese, type) => ({ japanese, reading: '', romaji: '', english: 'x', type });
    core.paintBlockTokens(el, assembled,
      [W('高', 'adjective'), W('波', 'noun')],
      {
        marker: 'gcwbUniv',
        excludeTags: bw.SKIP_SUBTREE_TAGS,
        stopAtNestedBlocks: true,
        decorateNativeRuby: true,
      });
    const baseColor = id => getComputedStyle(
      document.querySelector(`#${id} > .gcwb-auto-word`)).color;
    const color = id => getComputedStyle(document.getElementById(id)).color;
    return {
      assembled,
      highColor: baseColor('t17high'),
      highReadingColor: color('t17high-reading'),
      waveColor: baseColor('t17wave'),
      waveReadingColor: color('t17wave-reading'),
      readingTargets: el.querySelectorAll('rt.gcwb-auto-word, rt .gcwb-auto-word').length,
    };
  });
  assertEq('paired-ruby input excludes both readings', t17.assembled, '高波');
  assertEq('first base is adjective yellow', t17.highColor, 'rgb(251, 188, 4)');
  assertEq('first reading matches its base', t17.highReadingColor, 'rgb(251, 188, 4)');
  assertEq('second base is noun blue', t17.waveColor, 'rgb(66, 133, 244)');
  assertEq('second reading matches its base', t17.waveReadingColor, 'rgb(66, 133, 244)');
  assertEq('paired readings stay non-interactive', t17.readingTargets, 0);

  // ---- T18: a native-ruby word can straddle into outside okurigana.
  console.log('\nT18: native ruby + outside okurigana retain one word');
  const t18 = await page.evaluate(() => {
    const el = document.getElementById('t18');
    const { assembled } = core.collectBlockTextNodes(
      el, bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    core.paintBlockTokens(el, assembled,
      [{ japanese: '降り', reading: 'ふり', romaji: 'furi', english: 'to fall', type: 'verb' }],
      {
        marker: 'gcwbUniv',
        excludeTags: bw.SKIP_SUBTREE_TAGS,
        stopAtNestedBlocks: true,
        decorateNativeRuby: true,
      });
    const segments = [...el.querySelectorAll('.gcwb-auto-word')];
    const readings = [...el.querySelectorAll('rt')];
    return {
      assembled,
      segmentTexts: segments.map(s => s.textContent),
      segmentWords: segments.map(s => s.dataset.word),
      segmentColors: segments.map(s => getComputedStyle(s).color),
      readingTexts: readings.map(r => r.textContent),
      readingColors: readings.map(r => getComputedStyle(r).color),
      readingTargets: readings.filter(r => r.matches('.gcwb-auto-word')).length,
      fallbackMarkers: el.querySelectorAll('rp.gcwb-ruby-reading').length,
    };
  });
  assertEq('split-word input excludes rt/rp text', t18.assembled, '降り');
  assertEq('base and okurigana are separate segments', t18.segmentTexts, ['降', 'り']);
  assertEq('both segments retain the full word', t18.segmentWords, ['降り', '降り']);
  assertEq('both segments are verb green', t18.segmentColors, ['rgb(52, 168, 83)', 'rgb(52, 168, 83)']);
  assertEq('all reading text is preserved', t18.readingTexts, ['ふ', 'fu']);
  assertEq('consecutive readings match the verb', t18.readingColors, ['rgb(52, 168, 83)', 'rgb(52, 168, 83)']);
  assertEq('readings stay non-interactive', t18.readingTargets, 0);
  assertEq('rp fallbacks stay unmarked', t18.fallbackMarkers, 0);

  // ---- T19: shared core keeps native-ruby reading decoration opt-in.
  console.log('\nT19: native ruby reading decoration is opt-in');
  const t19 = await page.evaluate(() => {
    const el = document.getElementById('t19');
    const { assembled } = core.collectBlockTextNodes(
      el, bw.SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
    core.paintBlockTokens(el, assembled,
      [{ japanese: '海', reading: 'うみ', romaji: 'umi', english: 'sea', type: 'noun' }],
      {
        marker: 'gcwbAutoLite',
        excludeTags: bw.SKIP_SUBTREE_TAGS,
        stopAtNestedBlocks: true,
      });
    const ruby = document.getElementById('t19sea');
    const base = ruby.querySelector(':scope > .gcwb-auto-word');
    const reading = ruby.querySelector(':scope > rt');
    return {
      baseColor: getComputedStyle(base).color,
      readingColor: getComputedStyle(reading).color,
      readingMarked: reading.classList.contains('gcwb-ruby-reading'),
    };
  });
  assertEq('default path still paints the base', t19.baseColor, 'rgb(66, 133, 244)');
  assertEq('default path preserves the host reading color', t19.readingColor, 'rgb(51, 51, 51)');
  assertEq('default path does not mark the reading', t19.readingMarked, false);

  // ---- T20: a scoped rescan agrees with a whole-document scan
  // The universal colorizer no longer walks the whole document after every page
  // mutation; it walks up from the mutated node to its block and scans only
  // that. This is only safe if the blocks it finds are the same ones a full
  // scan would have produced for that subtree — otherwise a mutation would
  // silently re-segment a paragraph.
  console.log('\nT20: scoped rescan finds the same blocks as a full scan');
  const t20 = await page.evaluate(() => {
    const fullSet = new Set(bw.findJapaneseBlocks(document.body));

    // Every element that directly holds Japanese text is a plausible mutation
    // target, which is exactly what onMutations feeds to nearestBlockRoot.
    const hasJa = (s) => /[぀-ゟ゠-ヿ一-龯]/.test(s || '');
    const targets = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (hasJa(walker.currentNode.nodeValue) && walker.currentNode.parentElement) {
        targets.push(walker.currentNode.parentElement);
      }
    }

    let notInFull = 0;
    let rootNotBlock = 0;
    const covered = new Set();

    for (const target of targets) {
      const root = bw.nearestBlockRoot(target, new Map());
      if (root !== document.body && !bw.isBlockLevel(root, new Map())) rootNotBlock++;
      for (const block of bw.findJapaneseBlocks(root)) {
        covered.add(block);
        if (!fullSet.has(block)) notInFull++;
      }
    }

    // Scoping must not lose blocks either: scanning from every Japanese text
    // node's block root should reach everything the full scan reaches.
    const missed = [...fullSet].filter(b => !covered.has(b)).map(b => b.id || b.tagName);

    return { fullCount: fullSet.size, targets: targets.length, notInFull, rootNotBlock, missed };
  });
  assertTrue('fixture actually exercises many blocks', t20.fullCount > 5 && t20.targets > 5);
  assertEq('nearestBlockRoot always lands on a block boundary', t20.rootNotBlock, 0);
  assertEq('scoped scans invent no blocks a full scan would not find', t20.notInFull, 0);
  assertEq('scoped scans collectively miss no block', t20.missed, []);

  // A boundary dot translates one clause, so these pin that the painter never
  // hands a dot text belonging to a neighbouring clause, and that the dot for a
  // clause with no closing mark contributes nothing to the page's text.
  await page.evaluate(() => {
    const EX = new Set(['PRE', 'CODE', 'IMG', 'OBJECT']);
    const W = (japanese, type) => ({ japanese, reading: '', romaji: '', english: 'x', type });
    // Enough tokens to cover every fixture below; unlocatable ones are skipped.
    window.paintClauseFixture = (id, opts = {}) => {
      const el = document.getElementById(id);
      const analyzerText = core.collectBlockTextNodes(el, EX).assembled;
      const words = [...analyzerText.matchAll(/[぀-ゟ゠-ヿ一-龯]+/g)]
        .map(m => W(m[0], 'noun'));
      const painted = core.paintBlockTokens(el, analyzerText, words,
        { marker: 'gcwbAutoLite', excludeTags: EX, ...opts });
      return { painted, analyzerText };
    };
    window.dotsOf = (id) => [...document.getElementById(id)
      .querySelectorAll('.gcwb-auto-boundary')]
      .map(d => ({
        clause: d.dataset.clause || '',
        english: d.dataset.english || '',
        synthetic: d.dataset.gcwbSynth != null,
        text: d.textContent,
        childCount: d.childNodes.length,
        parentId: d.parentElement?.id || d.parentElement?.tagName,
      }));
  });

  // ---- T21: each dot carries its own clause, never the block translation
  console.log('\nT21: a dot reveals only its own clause');
  const t21 = await page.evaluate(() => {
    window.paintClauseFixture('t21', { translation: 'Whole block translation.' });
    return window.dotsOf('t21');
  });
  assertEq('one dot per clause', t21.length, 3);
  assertEq('each dot carries its own clause',
    t21.map(d => d.clause), ['最初の文です。', '次の文です。', '最後のことばです']);
  assertEq('no dot is seeded from the multi-clause block translation',
    t21.map(d => d.english), ['', '', '']);
  assertEq('the unterminated clause gets the synthetic dot',
    t21.map(d => d.synthetic), [false, false, true]);

  // ---- T22: a single-clause block can honestly seed its dot
  console.log('\nT22: a single-clause block seeds its dot');
  const t22 = await page.evaluate(() => {
    window.paintClauseFixture('t22', { translation: 'First sentence.' });
    return window.dotsOf('t22');
  });
  assertEq('one dot', t22.length, 1);
  assertEq('seeded with the block translation', t22[0].english, 'First sentence.');
  assertEq('and still carries its clause', t22[0].clause, '最初の文です。');

  // ---- T23: a synthetic dot is invisible to the page's text
  console.log('\nT23: a synthetic dot contributes no text');
  const t23 = await page.evaluate(() => {
    const before = document.getElementById('t23').textContent;
    window.paintClauseFixture('t23');
    const el = document.getElementById('t23');
    // Painting must not change the page's text at all — separation is CSS.
    const after = el.textContent;
    return { before, after, dots: window.dotsOf('t23') };
  });
  assertEq('textContent is byte-identical after painting', t23.after, t23.before);
  assertEq('no dot glyph leaked into the text', t23.after.includes('\u00B7'), false);
  assertEq('exactly one synthetic dot', t23.dots.length, 1);
  assertEq('the dot holds no child nodes', t23.dots[0].childCount, 0);
  assertEq('the dot renders no text of its own', t23.dots[0].text, '');

  // ---- T24: a clause with no Japanese is skipped entirely
  console.log('\nT24: non-Japanese clauses earn no dot');
  const t24 = await page.evaluate(() => {
    window.paintClauseFixture('t24');
    return window.dotsOf('t24');
  });
  assertEq('two dots, not three', t24.length, 2);
  assertEq('the Latin clause is absent from the dots',
    t24.map(d => d.clause), ['一つ目です。', '三つ目です。']);
  assertEq('no dot is anchored inside the Latin run',
    t24.some(d => d.clause.includes('Version')), false);

  // ---- T25: repainting a block does not stack dots
  console.log('\nT25: repaint is idempotent');
  const t25 = await page.evaluate(() => {
    window.paintClauseFixture('t21', { translation: 'Whole block translation.' });
    const el = document.getElementById('t21');
    return {
      dots: el.querySelectorAll('.gcwb-auto-boundary').length,
      nested: el.querySelectorAll('.gcwb-auto-boundary .gcwb-auto-boundary').length,
      synthetic: el.querySelectorAll('.gcwb-auto-boundary[data-gcwb-synth]').length,
    };
  });
  assertEq('still one dot per clause after a second paint', t25.dots, 3);
  assertEq('no dot nested inside another', t25.nested, 0);
  assertEq('no duplicate synthetic dot', t25.synthetic, 1);

  // ---- T26: a clause ends at a seam, so its dot lands before the nested block
  console.log('\nT26: a clause never spans a seam');
  const t26 = await page.evaluate(() => {
    const el = document.getElementById('t26');
    const EX = new Set(['PRE', 'CODE', 'IMG', 'OBJECT']);
    const analyzerText = core.collectBlockTextNodes(el, EX, { stopAtNestedBlocks: true }).assembled;
    const W = (japanese) => ({ japanese, reading: '', romaji: '', english: 'x', type: 'noun' });
    const words = [...analyzerText.matchAll(/[぀-ゟ゠-ヿ一-龯]+/g)].map(m => W(m[0]));
    core.paintBlockTokens(el, analyzerText, words,
      { marker: 'gcwbAutoLite', excludeTags: EX, stopAtNestedBlocks: true });
    const dot = el.querySelector(':scope > .gcwb-auto-boundary');
    const nested = el.querySelector(':scope > p');
    let order = null;
    if (dot && nested) {
      order = dot.compareDocumentPosition(nested) & Node.DOCUMENT_POSITION_FOLLOWING
        ? 'dot-first' : 'nested-first';
    }
    return { hasSeam: analyzerText.includes('\n'), isChild: !!dot, order };
  });
  assertTrue('the fixture actually seams', t26.hasSeam);
  assertEq('the dot is a direct child of the block', t26.isChild, true);
  assertEq('the dot precedes the nested block', t26.order, 'dot-first');

  // ---- T27: a synthetic dot is hoisted out of hostile ancestors
  console.log('\nT27: synthetic dots are hoisted out of ruby and anchors');
  const t27 = await page.evaluate(() => {
    window.paintClauseFixture('t27');
    const dots = window.dotsOf('t27');
    const insideAnchor = document.querySelectorAll('#t27 a .gcwb-auto-boundary').length;
    return { dots, insideAnchor };
  });
  assertEq('the anchor text earns a dot', t27.dots.length, 1);
  assertEq('no dot remains inside the anchor', t27.insideAnchor, 0);
  assertEq('the dot is re-parented to the block', t27.dots[0].parentId, 't27');

  // ---- T28: a coloured native reading is hoverable and answers with its base
  console.log('\nT28: native ruby readings are hoverable');
  const t28 = await page.evaluate(() => {
    // #t16 was painted with decorateNativeRuby in T16.
    const reading = document.querySelector('#t16rain > rt');
    const base = document.querySelector('#t16rain > .gcwb-auto-word');
    return {
      readingWord: reading?.dataset.word ?? null,
      readingEnglish: reading?.dataset.english ?? null,
      baseWord: base?.dataset.word ?? null,
      isTarget: window.tip.isTooltipTarget(reading),
      // The reading must stay out of every class-based word selector.
      countsAsWord: reading?.classList.contains('gcwb-auto-word'),
      readingTargets: document.querySelectorAll('#t16 rt.gcwb-auto-word').length,
      rpIsTarget: window.tip.isTooltipTarget(document.querySelector('#t18 rp')),
    };
  });
  assertEq('the reading carries its base word', t28.readingWord, t28.baseWord);
  assertEq('the reading carries the base gloss', t28.readingEnglish, 'x');
  assertEq('the tooltip accepts the reading', t28.isTarget, true);
  assertEq('the reading is still not a word span', t28.countsAsWord, false);
  assertEq('no rt was wrapped as a word', t28.readingTargets, 0);
  assertEq('an rp fallback is not a tooltip target', t28.rpIsTarget, false);

  // ---- T29: a zero-length boundary token wraps without disturbing the text
  console.log('\nT29: zero-length synthetic token is safe');
  const t29 = await page.evaluate(() => {
    const el = document.getElementById('t29');
    const node = el.firstChild;
    const before = el.textContent;
    let threw = null;
    try {
      window.mapper.wrapJapaneseTokensInTextNode(node, [
        { surface: 'ことば', start: 0, end: 3, type: 'noun', english: 'word' },
        { surface: '', start: 3, end: 3, isBoundary: true, synthetic: true, clause: 'ことば' },
      ]);
    } catch (e) {
      threw = String(e && e.name || e);
    }
    const dot = el.querySelector('.gcwb-auto-boundary');
    return {
      threw,
      before,
      after: el.textContent,
      dotIsLast: dot === el.lastElementChild,
      dotChildren: dot ? dot.childNodes.length : -1,
    };
  });
  assertEq('wrapping a zero-length token does not throw', t29.threw, null);
  assertEq('the visible text is unchanged', t29.after, t29.before);
  assertEq('the dot is the trailing element', t29.dotIsLast, true);
  assertEq('the dot holds no children', t29.dotChildren, 0);

  // ---- T30: a two-sentence chunk gives each mark its own sentence
  // Meet batches sentences into one chunk and translates the chunk as a unit, so
  // without splitting, both marks would reveal the same two-sentence English.
  console.log('\nT30: each Meet dot reveals only its own sentence');
  const t30 = await page.evaluate(() => {
    const el = document.getElementById('t30');
    const text = '行きます。着きました。';
    const words = [
      { japanese: '行き', reading: '', romaji: '', english: 'go', type: 'verb' },
      { japanese: 'ます', reading: '', romaji: '', english: 'polite', type: 'auxiliary' },
      { japanese: '着き', reading: '', romaji: '', english: 'arrive', type: 'verb' },
      { japanese: 'ました', reading: '', romaji: '', english: 'past', type: 'auxiliary' },
    ];
    const sentences = [{
      text,
      startIndex: 0,
      endIndex: text.length,
      breakdownData: { translation: "I'll go. I arrived.", words },
    }];
    window.wr.paintWordColoring(el, text, words, sentences);
    return {
      dots: [...el.querySelectorAll('.mm-boundary')].map(d => d.dataset.english),
      textContent: el.textContent,
      wordCount: el.querySelectorAll('.mm-word').length,
    };
  });
  assertEq('one dot per sentence', t30.dots.length, 2);
  assertEq('each dot carries its own sentence', t30.dots, ["I'll go.", 'I arrived.']);
  assertEq('the caption text is preserved exactly', t30.textContent, '行きます。着きました。');
  assertEq('words still paint', t30.wordCount, 4);

  // ---- T31: a translation that cannot be split falls back, it does not guess
  console.log('\nT31: unsplittable translations fall back to the chunk');
  const t31 = await page.evaluate(() => {
    const el = document.getElementById('t31');
    const text = '行きます。着きました。';
    const words = [{ japanese: '行き', reading: '', romaji: '', english: 'go', type: 'verb' }];
    const sentences = [{
      text,
      startIndex: 0,
      endIndex: text.length,
      breakdownData: { translation: 'I went and then arrived.', words },
    }];
    window.wr.paintWordColoring(el, text, words, sentences);
    return [...el.querySelectorAll('.mm-boundary')].map(d => d.dataset.english);
  });
  assertEq('both dots keep the whole-chunk translation', t31,
    ['I went and then arrived.', 'I went and then arrived.']);

  // ---- T32: an unterminated caption still gets a hoverable dot, with no text
  console.log('\nT32: Meet synthetic dot adds no caption text');
  const t32 = await page.evaluate(() => {
    const el = document.getElementById('t32');
    const text = 'まだ終わっていない文章';
    const words = [{ japanese: '文章', reading: '', romaji: '', english: 'text', type: 'noun' }];
    const sentences = [{
      text,
      startIndex: 0,
      endIndex: text.length,
      breakdownData: { translation: 'It is not finished yet.', words },
    }];
    window.wr.paintWordColoring(el, text, words, sentences);
    const dot = el.querySelector('.mm-boundary-synthetic');
    return {
      textContent: el.textContent,
      hasDot: !!dot,
      dotEnglish: dot ? dot.dataset.english : null,
      dotChildren: dot ? dot.childNodes.length : -1,
      dotIsLast: dot === el.lastElementChild,
    };
  });
  assertEq('the unterminated caption gets a dot', t32.hasDot, true);
  assertEq('the dot carries the sentence translation', t32.dotEnglish, 'It is not finished yet.');
  assertEq('caption text is byte-identical', t32.textContent, 'まだ終わっていない文章');
  assertEq('the dot holds no text node', t32.dotChildren, 0);
  assertEq('the dot trails the caption', t32.dotIsLast, true);

  // ---------------------------------------------------------------------------
  // T34-T40: word islands (word-island.js).
  //
  // These run before T33 on purpose: T33 navigates and then overwrites
  // documentElement.innerHTML, which throws away the fixture and every module
  // loadFixture() put on window.
  //
  // Paint every island fixture once up front. paintBlockTokens excludes existing
  // word spans from its assembly, so a second paint of the same block sees only
  // the leftover punctuation and drifts.
  // ---------------------------------------------------------------------------
  await page.evaluate(() => {
    const W = (japanese, type) => ({ japanese, reading: '', romaji: '', english: 'x', type });
    const paint = (id, text, words) => core.paintBlockTokens(
      document.getElementById(id), text, words,
      { marker: 'gcwbUniv', excludeTags: bw.SKIP_SUBTREE_TAGS, stopAtNestedBlocks: true });

    paint('t34', '今日は、いい天気ですね', [
      W('今日', 'noun'), W('は', 'particle'), W('いい', 'adjective'),
      W('天気', 'noun'), W('です', 'copula'), W('ね', 'particle')]);
    paint('t35', '最初の文です。次の文です。', [
      W('最初', 'noun'), W('の', 'particle'), W('文', 'noun'), W('です', 'copula'),
      W('次', 'noun'), W('の', 'particle'), W('文', 'noun'), W('です', 'copula')]);
    paint('t36', '最初の行\n二行目です', [
      W('最初', 'noun'), W('の', 'particle'), W('行', 'counter'),
      W('二行目', 'counter'), W('です', 'copula')]);
    paint('t37', '言葉の練習', [W('言葉', 'noun'), W('の', 'particle'), W('練習', 'noun')]);
    paint('t38', 'よく合う人', [W('よく', 'adverb'), W('合う', 'verb'), W('人', 'noun')]);
    paint('t39br', '一行目のことば\n二行目のことば', [
      W('一行目', 'counter'), W('の', 'particle'), W('ことば', 'noun'),
      W('二行目', 'counter'), W('の', 'particle'), W('ことば', 'noun')]);
    // A parent block and its nested block are separate paint units, and the
    // parent's assembly stops at the child, so each is painted on its own.
    paint('t39n', 'そとのことば', [W('そと', 'noun'), W('の', 'particle'), W('ことば', 'noun')]);
    paint('t39np', 'なかのことば', [W('なか', 'noun'), W('の', 'particle'), W('ことば', 'noun')]);

    // Bind the real click policy so the link cases below can be driven with real
    // pointer events rather than by calling the reducer.
    isl.setupWordIsland({});

    window.words = (id) => [...document.querySelectorAll(`#${id} .gcwb-auto-word`)];
    window.tap = (id, i) => isl.toggleWordSelection(window.words(id)[i]);
    window.lit = (id) => window.words(id).filter(s => s.classList.contains('gcwb-island'))
      .map(s => s.textContent);
    window.island = () => ({
      phrase: isl.getIslandPhrase(),
      lit: [...document.querySelectorAll('.gcwb-island')].map(s => s.textContent),
      ends: [
        document.querySelectorAll('.gcwb-island-start').length,
        document.querySelectorAll('.gcwb-island-end').length,
      ],
    });
  });

  // ---- T34: one click selects exactly one word
  //
  // The negative half matters most: single-segment words carry no seg id, so a
  // grouping test that compares the raw attribute would match undefined against
  // undefined and light the whole abutting run.
  console.log('\nT34: a click selects one word');
  const t34 = await page.evaluate(() => { isl.clearIsland(); tap('t34', 0); return island(); });
  assertEq('only the clicked word lights up', t34.lit, ['今日']);
  assertEq('the phrase is that word', t34.phrase, '今日');
  assertEq('a lone word is both ends of the ribbon', t34.ends, [1, 1]);

  // ---- T35: joining rightwards, including across a comma
  console.log('\nT35: clicking the next word joins it');
  const t35 = await page.evaluate(() => {
    isl.clearIsland();
    tap('t34', 0); tap('t34', 1);
    const two = island();
    tap('t34', 2);
    // The ribbon has to close the abut hairline and the comma, or the run reads
    // as a row of chips rather than one object.
    const reach = words('t34').slice(0, 3)
      .map(s => parseFloat(s.style.getPropertyValue('--gcwb-island-bridge')) || 0);
    return { two, three: island(), reach };
  });
  assertEq('two words join', t35.two.lit, ['今日', 'は']);
  assertEq('the phrase is the run', t35.two.phrase, '今日は');
  assertEq('the ribbon still has one of each end', t35.two.ends, [1, 1]);
  assertEq('a comma between words is a separator, not a stop', t35.three.phrase, '今日は、いい');
  assertTrue('the ribbon reaches across the abut hairline', t35.reach[0] > 0);
  assertTrue('and across the comma', t35.reach[1] > t35.reach[0]);
  assertEq('but not past the last word', t35.reach[2], 0);

  // ---- T36: joining leftwards
  //
  // The only case that catches a left hop walking from the clicked word instead
  // of from the island's head, which can never reach a head on its right.
  console.log('\nT36: clicking the previous word joins it');
  const t36 = await page.evaluate(() => {
    isl.clearIsland();
    tap('t34', 2); tap('t34', 1);
    const back = island();
    tap('t34', 0);
    return { back, further: island() };
  });
  assertEq('the earlier word joins the front', t36.back.phrase, 'は、いい');
  assertEq('and keeps joining leftwards', t36.further.phrase, '今日は、いい');
  assertEq('the run is in reading order', t36.further.lit, ['今日', 'は', 'いい']);

  // ---- T37: growing, shrinking, collapsing, clearing
  console.log('\nT37: the island only ever stays contiguous');
  const t37 = await page.evaluate(() => {
    isl.clearIsland();
    tap('t34', 0); tap('t34', 1); tap('t34', 2);      // 今日 は いい
    const grown = island().phrase;
    tap('t34', 0);                                     // head: shrink
    const head = island().phrase;
    tap('t34', 2);                                     // tail: shrink
    const tail = island().phrase;
    tap('t34', 1);                                     // the last one: clear
    const cleared = island();

    tap('t34', 0); tap('t34', 1); tap('t34', 2);
    tap('t34', 1);                                     // interior: collapse
    const interior = island().phrase;

    isl.clearIsland();
    tap('t34', 0);
    tap('t34', 3);                                     // not touching: restart
    const apart = island().phrase;
    return { grown, head, tail, cleared, interior, apart };
  });
  assertEq('three words join', t37.grown, '今日は、いい');
  assertEq('clicking the head drops it', t37.head, 'は、いい');
  assertEq('clicking the tail drops it', t37.tail, 'は');
  assertEq('clicking the last word clears', t37.cleared.lit, []);
  assertEq('and the phrase goes with it', t37.cleared.phrase, '');
  assertEq('clicking the middle collapses to it', t37.interior, 'は');
  assertEq('clicking a word that touches nothing restarts there', t37.apart, '天気');

  // ---- T38: a word split across text nodes is one unit
  //
  // 合う paints as 合 (inside the wruby) plus う (outside it). Selecting a third
  // of a word reads as broken, and the reading in between must not reach the
  // translator.
  console.log('\nT38: a straddled word selects whole');
  const t38 = await page.evaluate(() => {
    isl.clearIsland();
    const spans = words('t38');
    const au = spans.filter(s => s.dataset.word === '合う');
    tap('t38', spans.indexOf(au[0]));
    const one = island();
    const right = spans.find(s => s.dataset.word === '人');
    isl.toggleWordSelection(right);
    const withRight = island().phrase;
    const left = spans.find(s => s.dataset.word === 'よく');
    isl.toggleWordSelection(left);
    return {
      segs: au.map(s => s.textContent),
      segIds: new Set(au.map(s => s.dataset.gcwbSeg)).size,
      plainHasSeg: spans.find(s => s.dataset.word === '人').dataset.gcwbSeg,
      one, withRight, whole: island().phrase,
    };
  });
  assertEq('the word painted as two segments', t38.segs, ['合', 'う']);
  assertEq('both segments share one id', t38.segIds, 1);
  assertEq('a whole word carries no id at all', t38.plainHasSeg, undefined);
  assertEq('clicking one segment lights the word', t38.one.lit, ['合', 'う']);
  assertEq('the reading between them is not in the phrase', t38.one.phrase, '合う');
  assertEq('the ribbon caps the word once, not once per segment', t38.one.ends, [1, 1]);
  assertEq('a straddled word joins rightwards', t38.withRight, '合う人');
  assertEq('and leftwards', t38.whole, 'よく合う人');

  // ---- T39: what an island refuses to cross
  console.log('\nT39: islands stop where the analyzer stops');
  const t39 = await page.evaluate(() => {
    const across = (id, a, b) => { isl.clearIsland(); tap(id, a); tap(id, b); return island().phrase; };
    isl.clearIsland();
    tap('t34', 0); tap('t34', 1); tap('t34', 2);
    tap('t34', 3); tap('t34', 4); tap('t34', 5);
    const whole = island().phrase;
    return {
      whole,
      dot: across('t35', 3, 4),      // です | 。 | 次
      br: across('t39br', 2, 3),     // either side of a <br>
      pre: across('t36', 2, 3),      // either side of a preserved newline
      nested: (() => {               // parent block text and a nested <p>
        isl.clearIsland();
        const outer = [...document.querySelectorAll('#t39n > .gcwb-auto-word')];
        const inner = [...document.querySelectorAll('#t39np .gcwb-auto-word')];
        if (!outer.length || !inner.length) return 'no fixture';
        isl.toggleWordSelection(outer[outer.length - 1]);
        isl.toggleWordSelection(inner[0]);
        return island().lit;
      })(),
    };
  });
  assertEq('a whole clause joins, and no synthetic dot glyph rides along',
    t39.whole, '今日は、いい天気ですね');
  assertEq('a clause dot stops the run', t39.dot, '次');
  assertEq('a <br> stops the run', t39.br, '二行目');
  assertEq('a preserved newline stops the run', t39.pre, '二行目');
  assertEq('a nested block is a different island', t39.nested, ['なか']);

  // ---- T40: the page keeps its own text, and its own clicks
  console.log('\nT40: selecting changes nothing the page owns');
  const beforeIsland = await page.evaluate(() => document.getElementById('t34').textContent);
  await page.evaluate(() => { isl.clearIsland(); tap('t34', 0); tap('t34', 1); });
  const duringIsland = await page.evaluate(() => document.getElementById('t34').textContent);

  await page.evaluate(() => { location.hash = ''; });
  await page.locator('#t37a .gcwb-auto-word').first().click();
  const plainInLink = await page.evaluate(() => ({
    hash: location.hash,
    lit: [...document.querySelectorAll('#t37 .gcwb-island')].length,
  }));

  await page.evaluate(() => { location.hash = 'reset'; });
  await page.locator('#t37a .gcwb-auto-word').first().click({ modifiers: ['Alt'] });
  const altInLink = await page.evaluate(() => ({
    hash: location.hash,
    phrase: isl.getIslandPhrase(),
  }));

  await page.keyboard.press('Escape');
  const afterEscape = await page.evaluate(() => ({
    phrase: isl.getIslandPhrase(),
    lit: document.querySelectorAll('.gcwb-island').length,
    text: document.getElementById('t34').textContent,
    // Clearing has to take the ribbon's measurements with it, style attribute
    // and all, or the page keeps an attribute it never had.
    styled: words('t34').filter(s => s.hasAttribute('style')).length,
  }));

  assertEq('an island adds no text', duringIsland, beforeIsland);
  assertEq('a plain click inside a link belongs to the page', plainInLink.hash, '#t37');
  assertEq('and selects nothing', plainInLink.lit, 0);
  assertEq('alt+click inside a link does not navigate', altInLink.hash, '#reset');
  assertEq('and selects the word', altInLink.phrase, '言葉');
  assertEq('escape clears the island', afterEscape.phrase, '');
  assertEq('and removes every band', afterEscape.lit, 0);
  assertEq('and leaves no inline style behind', afterEscape.styled, 0);
  assertEq('and the text is still the page own', afterEscape.text, beforeIsland);

  // ---------------------------------------------------------------------------
  // T33: isRedmine() must not fire on a stock Rails page.
  //
  // `controller-* action-*` on <body> plus #wrapper is a Rails idiom, not a
  // Redmine signature. This used to be fenced off by a static host match; the
  // all-sites colorizer now runs the detector on every page, and a false
  // positive makes isBuiltInSurface() return true, which silently disables
  // colorizing on that site. A false negative only loses the richer Redmine
  // treatment, so the detector must err toward "not Redmine".
  // ---------------------------------------------------------------------------
  console.log('\nT33: Redmine detection does not misfire on plain Rails');

  async function detectsRedmine(html) {
    await page.goto(`${BASE}/tests/fixtures/universal-dom.html`);
    await page.evaluate((h) => { document.documentElement.innerHTML = h; }, html);
    return page.evaluate(async () => {
      const { isRedmine } = await import('/src/content/redmine/message-finder.js');
      return isRedmine();
    });
  }

  const railsOnly = await detectsRedmine(
    '<head><title>A Rails app</title></head>' +
    '<body class="controller-articles action-index">' +
    '<div id="wrapper"><div id="main"><p>日本語のテキストです。</p></div></div></body>'
  );
  assertEq('a stock Rails page is not Redmine', railsOnly, false);

  const realRedmine = await detectsRedmine(
    '<head><meta name="description" content="Redmine"></head>' +
    '<body class="controller-issues action-show">' +
    '<div id="wrapper"><div id="top-menu"><div id="account"></div></div>' +
    '<div id="main"><div id="content">課題の説明です。</div></div></div>' +
    '<div id="footer"><a href="https://www.redmine.org/">Redmine</a></div></body>'
  );
  assertEq('a real Redmine page is Redmine', realRedmine, true);

  const noRailsClasses = await detectsRedmine(
    '<head><meta name="description" content="Redmine"></head>' +
    '<body><div id="wrapper"><div id="top-menu"><div id="account"></div></div></div></body>'
  );
  assertEq('Redmine markers alone are not enough', noRailsClasses, false);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
