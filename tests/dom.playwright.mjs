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
      visible: el.textContent.replace(/ /g, ''),
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

  // ---- T8: mapper word field + thin space
  console.log('\nT8: wrapJapaneseTokensInTextNode word field');
  const t8 = await page.evaluate(() => {
    const el = document.getElementById('t8');
    const textNode = el.firstChild;
    mapper.wrapJapaneseTokensInTextNode(textNode, [
      { surface: 'ことば', word: '言葉', start: 0, end: 3, reading: 'ことば', romaji: 'kotoba', english: 'word', type: 'noun' },
      { surface: 'です', start: 3, end: 5, reading: '', romaji: 'desu', english: 'copula (to be)', type: 'copula' },
    ]);
    const spans = [...el.querySelectorAll('.gcwb-auto-word')];
    return {
      words: spans.map(s => s.dataset.word),
      texts: spans.map(s => s.textContent),
      joined: el.textContent,
    };
  });
  assertEq('dataset.word uses t.word then falls back to surface', t8.words, ['言葉', 'です']);
  assertEq('visible text stays the node slices', t8.texts, ['ことば', 'です']);
  assertEq('separator space still inserted between abutting words', t8.joined, 'ことば です');

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
      marker: el.dataset.gcwbAutoLite,
    };
  });
  assertEq('default assembly spans nested p', t9.analyzerText, '最初の文です。中の言葉');
  assertEq('painted', t9.painted, true);
  assertEq('word inside nested p painted', t9.nestedPainted, '中');
  assertEq('boundary dot carries the translation', t9.boundaryEnglish, 'First sentence.');
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
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
