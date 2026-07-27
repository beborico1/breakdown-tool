/**
 * Integrated check for the universal colorizer.
 *
 * The dom suite exercises the painting modules directly and the e2e suite
 * exercises the NLP round trip; this one runs the whole thing: the real unpacked
 * extension, real kuromoji output, a real page, real hover. It is the only place
 * that can catch a regression in what a manual selection copies, because the
 * synthetic dot's glyph is CSS generated content and Chrome pulls generated
 * content into a copy unless it is excluded from selection.
 *
 * The extension is loaded from a scratch copy whose static content_scripts also
 * match the loopback origin. That avoids depending on the all-sites host grant
 * (which Chrome will only give for an explicit user gesture) and on the dynamic
 * registration, which only runs at install or startup. The copy is a real copy:
 * Chrome does not follow symlinks when loading an unpacked extension.
 *
 * Local only, like test:dom and test:e2e. Run: node tests/universal.playwright.mjs
 */
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ORIGIN_MATCH = 'http://127.0.0.1/*'; // match patterns ignore the port

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>t</title></head>
<body>
<article>
  <p id="p1">最初の文です。次の文です。最後のことばです</p>
  <p id="p2">終わりのない長い文章</p>
  <p id="p3">Version 2.5 released。</p>
  <p id="p4">これは<ruby>日本語<rt>にほんご</rt></ruby>のテストです。</p>
</article>
</body></html>`;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}

/** Copy the extension and widen its static matches to the test origin. */
function buildScratchExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'kaigi-ext-'));
  mkdirSync(dir, { recursive: true });
  for (const part of ['assets', 'dist', 'src']) {
    cpSync(join(REPO, part), join(dir, part), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf-8'));
  manifest.content_scripts[0].matches.push(TEST_ORIGIN_MATCH);
  manifest.host_permissions = [...(manifest.host_permissions || []), TEST_ORIGIN_MATCH];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const extDir = buildScratchExtension();
const profile = mkdtempSync(join(tmpdir(), 'kaigi-profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, // an unpacked MV3 extension needs a real browser process
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
  ],
});

try {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  // Turn on the two flags the colorizer gates on, then warm the pipeline so the
  // first paint is not racing a cold tokenizer load.
  const cfg = await ctx.newPage();
  await cfg.goto(`chrome-extension://${extId}/src/pages/popup/popup.html`);
  await cfg.evaluate(() => new Promise((resolve) => {
    chrome.storage.sync.set({ universalMode: true, useOfflineNlp: true }, resolve);
  }));
  await cfg.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'kaigi-nlp-proxy', op: 'warmup', text: '' }, () => resolve());
  }));
  await cfg.close();

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

  await page.goto(BASE);
  const beforeP1 = await page.textContent('#p1');
  const beforeP2 = await page.textContent('#p2');

  await page.waitForSelector('.gcwb-auto-word', { timeout: 30000 });
  await page.waitForTimeout(1500); // let the remaining blocks settle

  const state = await page.evaluate(() => ({
    words: document.querySelectorAll('.gcwb-auto-word').length,
    dots: [...document.querySelectorAll('.gcwb-auto-boundary')].map(d => ({
      clause: d.dataset.clause || '',
      synthetic: d.dataset.gcwbSynth != null,
      text: d.textContent,
      inP: d.closest('p')?.id || null,
    })),
    // The painter separates abutting tokens with its own space; the fixture has
    // none of its own, so stripping spaces isolates what the dots contributed.
    p1Text: document.getElementById('p1').textContent.replace(/[  ]/g, ''),
    p2Text: document.getElementById('p2').textContent.replace(/[  ]/g, ''),
    rtWord: document.querySelector('#p4 rt')?.dataset.word ?? null,
  }));

  console.log('\nuniversal colorizer on a real page');
  ok('words painted', state.words > 0, `got ${state.words}`);
  ok('dots painted', state.dots.length > 0, JSON.stringify(state.dots));

  const p1dots = state.dots.filter(d => d.inP === 'p1');
  ok('one dot per clause', p1dots.length === 3, JSON.stringify(p1dots));
  ok('each dot carries a distinct clause',
    new Set(p1dots.map(d => d.clause)).size === p1dots.length,
    JSON.stringify(p1dots.map(d => d.clause)));

  const p2dots = state.dots.filter(d => d.inP === 'p2');
  ok('an unterminated phrase gets a synthetic dot',
    p2dots.length === 1 && p2dots[0].synthetic, JSON.stringify(p2dots));
  ok('the synthetic dot renders no text of its own',
    p2dots.every(d => d.text === ''), JSON.stringify(p2dots));

  ok('a clause with no Japanese gets no dot',
    state.dots.filter(d => d.inP === 'p3').length === 0,
    JSON.stringify(state.dots.filter(d => d.inP === 'p3')));

  ok('painting leaves the terminated paragraph text intact', state.p1Text === beforeP1,
    `before=${JSON.stringify(beforeP1)} after=${JSON.stringify(state.p1Text)}`);
  ok('painting leaves the dotted paragraph text intact', state.p2Text === beforeP2,
    `before=${JSON.stringify(beforeP2)} after=${JSON.stringify(state.p2Text)}`);
  ok('a native ruby reading carries its base word', !!state.rtWord, String(state.rtWord));

  console.log('\nhover');
  await page.hover('#p1 .gcwb-auto-boundary');
  await page.waitForTimeout(500);
  const dotTip = await page.evaluate(() => {
    const t = document.querySelector('.gcwb-word-tooltip.gcwb-boundary-tooltip');
    return t ? t.textContent.trim() : null;
  });
  ok('hovering a dot opens the boundary tooltip', dotTip !== null, String(dotTip));

  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  await page.hover('#p1 .gcwb-auto-word');
  await page.waitForTimeout(300);
  const wordTip = await page.evaluate(() => {
    const t = document.querySelector('.gcwb-word-tooltip:not(.gcwb-boundary-tooltip)');
    return t ? t.textContent.trim() : null;
  });
  ok('hovering a word still opens the word tooltip', !!wordTip, String(wordTip));

  // Before the copy-safety block on purpose: a live island would change what
  // that block is measuring.
  console.log('\nword island');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  const p2words = page.locator('#p2 .gcwb-auto-word');
  await p2words.nth(0).click();
  await p2words.nth(1).click();
  const joined = await page.evaluate(() => {
    const lit = [...document.querySelectorAll('#p2 .gcwb-island')];
    return { count: lit.length, text: lit.map(s => s.textContent).join('') };
  });
  ok('clicking two touching words joins them', joined.count >= 2, JSON.stringify(joined));

  // Park the pointer first. The tooltip the last click opened can sit over the
  // island it describes, and hovering into it instead of the word would take the
  // tooltip away rather than open one.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  await p2words.nth(0).hover();
  await page.waitForTimeout(1200);
  const islandTip = await page.evaluate(() => {
    const t = document.querySelector('.gcwb-word-tooltip.gcwb-island-tooltip');
    return t ? t.querySelector('.gcwb-tooltip-japanese')?.textContent : null;
  });
  ok('hovering the island shows the joined phrase', islandTip === joined.text,
    `tooltip=${JSON.stringify(islandTip)} island=${JSON.stringify(joined.text)}`);

  const afterIsland = await page.evaluate(() =>
    document.getElementById('p2').textContent.replace(/[  ]/g, ''));
  ok('an island leaves the paragraph text untouched', afterIsland === beforeP2,
    `before=${JSON.stringify(beforeP2)} after=${JSON.stringify(afterIsland)}`);

  await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  const cleared = await page.evaluate(() => document.querySelectorAll('.gcwb-island').length);
  ok('escape clears the island', cleared === 0, `still lit: ${cleared}`);

  console.log('\ncopy safety');
  const selected = await page.evaluate(() => {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('p2'));
    sel.addRange(r);
    return sel.toString();
  });
  ok('a selection spanning a synthetic dot excludes its glyph',
    !selected.includes('·'), JSON.stringify(selected));
} finally {
  await ctx.close();
  server.close();
  rmSync(extDir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
