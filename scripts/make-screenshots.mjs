#!/usr/bin/env node
// Capture the Chrome Web Store screenshots deterministically.
//
// Replaces a manual "resize the window, Cmd+Shift+4, crop in Preview" procedure that
// produced nothing reproducible and pointed at a directory which never existed.
//
// The hard problem — getting the real colorizer to run on a page we control, without
// the all-hosts permission prompt, which needs a genuine user gesture — is already
// solved by tests/universal.playwright.mjs. Same approach here: copy the extension to
// a scratch directory and widen its static content_scripts to the local test origin.
//
// Output: 1280x800 PNGs (the store's preferred size), captured as a 640x400 viewport
// at deviceScaleFactor 2 so text is rendered at 2x rather than upscaled. Plus the
// 440x280 small promo tile.
//
// Usage:  npm run screenshots

import { chromium } from 'playwright';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'assets/store-screenshots');
const DEMO = path.join(ROOT, 'assets/demo/article.html');

// Match patterns ignore the port but not the host, so the demo page must be served
// from 127.0.0.1 and not localhost.
const TEST_ORIGIN_MATCH = 'http://127.0.0.1/*';

const SHOT = { width: 640, height: 400 };   // x2 => 1280x800
const TILE = { width: 220, height: 140 };   // x2 => 440x280

/** Copy the extension and widen its static matches to the demo origin. */
function buildScratchExtension() {
  const dir = mkdtempSync(path.join(tmpdir(), 'jic-shots-ext-'));
  // A real copy, not a symlink: Chrome does not follow symlinks for unpacked
  // extensions.
  for (const part of ['assets', 'dist', 'src']) {
    cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches.push(TEST_ORIGIN_MATCH);
  manifest.host_permissions = [...(manifest.host_permissions || []), TEST_ORIGIN_MATCH];
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

const demoHtml = readFileSync(DEMO, 'utf8');
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(demoHtml);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const DEMO_URL = `http://127.0.0.1:${server.address().port}/`;

mkdirSync(OUT, { recursive: true });
const extDir = buildScratchExtension();
const profile = mkdtempSync(path.join(tmpdir(), 'jic-shots-prof-'));

const shots = [];
async function capture(name, page, clip) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  shots.push(file);
  console.log(`  wrote ${name}.png`);
}

const context = await chromium.launchPersistentContext(profile, {
  headless: false,                        // Chromium will not load MV3 headless
  viewport: SHOT,
  deviceScaleFactor: 2,                   // must be set on the context, not the page
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
    '--hide-scrollbars',                  // a scrollbar in a store screenshot looks broken
  ],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  console.log(`extension ${extId}`);

  // ---- Turn the colorizer on, and warm the dictionaries so the first paint is not
  // racing a cold tokenizer (a ~200 MB load on first use).
  const boot = await context.newPage();
  await boot.goto(`chrome-extension://${extId}/src/pages/popup/popup.html`);
  await boot.evaluate(async () => {
    await chrome.storage.sync.set({ universalMode: true });
    await new Promise((r) => chrome.runtime.sendMessage(
      { type: 'kaigi-nlp-proxy', op: 'warmup', text: '' }, () => r()
    ));
  });

  // ---- Seed vocabulary so "Your words" shows a populated dashboard rather than its
  // empty state. Uses the product's own store, so the shot reflects real rendering.
  await boot.evaluate(async () => {
    const { mergeWordCounts } = await import('/src/content/core/frequency-store.js');
    const now = Date.now();
    const seed = [
      ['朝', 'あさ', 'asa', 'morning', 'noun', 14],
      ['歩く', 'あるく', 'aruku', 'to walk', 'verb', 11],
      ['静か', 'しずか', 'shizuka', 'quiet; still', 'adjective', 9],
      ['空気', 'くうき', 'kuuki', 'air; atmosphere', 'noun', 8],
      ['聞こえる', 'きこえる', 'kikoeru', 'to be audible', 'verb', 7],
      ['橋', 'はし', 'hashi', 'bridge', 'noun', 6],
      ['匂い', 'におい', 'nioi', 'smell; scent', 'noun', 6],
      ['落ちる', 'おちる', 'ochiru', 'to fall', 'verb', 5],
      ['心', 'こころ', 'kokoro', 'heart; mind', 'noun', 5],
      ['旅', 'たび', 'tabi', 'journey; travel', 'noun', 4],
      ['変わる', 'かわる', 'kawaru', 'to change', 'verb', 4],
      ['宿', 'やど', 'yado', 'lodging; inn', 'noun', 3],
      ['急ぐ', 'いそぐ', 'isogu', 'to hurry', 'verb', 3],
      ['葉', 'は', 'ha', 'leaf', 'noun', 3],
      ['冷たい', 'つめたい', 'tsumetai', 'cold to the touch', 'adjective', 2],
    ];
    const updates = new Map();
    for (const [japanese, reading, romaji, english, type, count] of seed) {
      updates.set(`${japanese}|${type}`, {
        japanese, reading, romaji, english, type, count,
        firstSeen: now - 86400000 * 9, lastSeen: now - 3600000,
      });
    }
    await mergeWordCounts(updates);
  });
  await boot.close();

  // ---- 1 & 2: the demo article, colorized by the real extension.
  const article = await context.newPage();
  await article.goto(DEMO_URL);
  await article.waitForSelector('.gcwb-auto-word', { timeout: 40000 });
  await article.waitForTimeout(2500);           // let the remaining blocks land
  const painted = await article.$$eval('.gcwb-auto-word', n => n.length);
  console.log(`  demo page painted ${painted} words`);
  if (painted < 40) throw new Error(`only ${painted} words painted; the shot would look empty`);

  // A word tooltip is the single most persuasive frame: it shows colour AND meaning.
  const word = article.locator('main p .gcwb-auto-word').nth(6);
  await word.hover();
  await article.waitForSelector('.gcwb-word-tooltip', { timeout: 10000 });
  await article.waitForTimeout(700);
  await capture('1-article-word-tooltip', article);

  // Shot 2 is the density shot: several paragraphs of colour with nothing on top of
  // it. Deliberately does NOT rely on the clause tooltip — that needs Chrome's
  // on-device translator, which is absent from the Chromium Playwright downloads, so
  // depending on it would produce an empty frame on some machines and a good one on
  // others.
  await article.mouse.move(0, 0);
  await article.evaluate(() => window.scrollTo(0, 300));
  await article.waitForTimeout(500);
  await capture('2-article-colorized', article);
  await article.close();

  // ---- 3: Your words, populated.
  const words = await context.newPage();
  // This page is dark by design (frequency.css hardcodes #1F1F1F, with no
  // prefers-color-scheme query), so the shot is dark on purpose rather than because
  // the OS theme leaked in.
  await words.goto(`chrome-extension://${extId}/src/pages/frequency/frequency.html`);
  await words.waitForSelector('.word-grid', { timeout: 15000 });
  await words.waitForTimeout(1800);
  // Three collapsed accordions sit above the vocabulary and took most of the frame.
  // Hide them so the shot is about the words.
  await words.evaluate(() => {
    // The wrapper is .collapsible-card, not .collapsible — an earlier selector missed
    // it and two accordions still took half the frame.
    for (const id of ['statsToggle', 'filtersToggle']) {
      document.getElementById(id)?.closest('.collapsible-card')?.style.setProperty('display', 'none');
    }
    document.querySelector('.anki-guide')?.style.setProperty('display', 'none');
  });
  await words.waitForTimeout(400);
  await capture('3-your-words', words);
  await words.close();

  // ---- 4: the welcome page, whose sample is painted by the real pipeline.
  const welcome = await context.newPage();
  await welcome.goto(`chrome-extension://${extId}/src/pages/welcome/welcome.html`);
  await welcome.emulateMedia({ colorScheme: 'light' });
  await welcome.waitForSelector('#sample .gcwb-auto-word', { timeout: 40000 });
  await welcome.waitForTimeout(1200);
  // Scroll so the coloured sample and the colour legend are both in frame — they are
  // what the shot is for, and at 640 CSS px both sat below the fold.
  await welcome.evaluate(() => {
    document.getElementById('sample').scrollIntoView({ block: 'center' });
  });
  await welcome.waitForTimeout(400);
  await capture('4-welcome', welcome);
  await welcome.close();

  // ---- 5: the popup over the article.
  //
  // Captured separately and composited, NOT framed in an iframe: a web page cannot
  // frame a chrome-extension:// page unless it is listed in web_accessible_resources,
  // and that block was removed on purpose (it exposed 24 MB of dictionaries to every
  // site). An iframe here rendered Chrome's broken-page glyph.
  const bg = await context.newPage();
  await bg.goto(DEMO_URL);
  await bg.waitForSelector('.gcwb-auto-word', { timeout: 40000 });
  await bg.waitForTimeout(2000);
  await bg.mouse.move(0, 0);
  const bgFile = path.join(tmpdir(), 'jic-shot-bg.png');
  await bg.screenshot({ path: bgFile });
  await bg.close();

  // The popup at its real width. A narrow context so nothing is stretched.
  const popCtx = await chromium.launchPersistentContext(
    mkdtempSync(path.join(tmpdir(), 'jic-pop-')),
    {
      headless: false,
      viewport: { width: 340, height: 340 },
      deviceScaleFactor: 2,
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        '--no-first-run', '--hide-scrollbars',
      ],
    }
  );
  let [psw] = popCtx.serviceWorkers();
  if (!psw) psw = await popCtx.waitForEvent('serviceworker', { timeout: 30000 });
  const popExtId = new URL(psw.url()).host;
  const pop = await popCtx.newPage();
  await pop.emulateMedia({ colorScheme: 'light' });
  await pop.goto(`chrome-extension://${popExtId}/src/pages/popup/popup.html`);
  await pop.evaluate(async () => { await chrome.storage.sync.set({ universalMode: true }); });

  // The popup describes whatever the ACTIVE tab is. Captured on its own it reported
  // "Chrome does not let extensions run on this page", because its own
  // chrome-extension:// tab was the active one — which in a store screenshot reads as
  // an error. So open the demo page after it, making that the active tab, and reload
  // the popup so its init() queries the article instead.
  const popDemo = await popCtx.newPage();
  await popDemo.goto(DEMO_URL);
  await popDemo.waitForSelector('.gcwb-auto-word', { timeout: 40000 });
  await popDemo.waitForTimeout(2000);

  await pop.reload();
  await pop.waitForFunction(
    () => !/does not let extensions/.test(document.getElementById('heroStatusText')?.textContent || ''),
    null,
    { timeout: 15000 }
  ).catch(() => console.log('  ! popup still reports a restricted tab'));
  await pop.waitForTimeout(1200);
  const statusLine = await pop.textContent('#heroStatusText').catch(() => '');
  console.log(`  popup status: "${statusLine.trim()}"`);
  const popFile = path.join(tmpdir(), 'jic-shot-popup.png');
  await pop.screenshot({ path: popFile });
  await popCtx.close();

  // Two plain steps rather than one clever clone-stack: build the shadowed popup as
  // its own file, then composite it. An earlier single-invocation version mangled the
  // alpha channel and produced a washed-out frame.
  const shadowed = path.join(tmpdir(), 'jic-shot-popup-shadow.png');
  execFileSync('magick', [
    popFile, '-resize', '440x',
    '(', '+clone', '-background', 'black', '-shadow', '55x14+0+7', ')',
    '+swap', '-background', 'none', '-layers', 'merge', '+repage',
    shadowed,
  ]);
  const composed = path.join(OUT, '5-popup.png');
  execFileSync('magick', [bgFile, shadowed, '-geometry', '+760+42', '-composite', composed]);
  shots.push(composed);
  console.log('  wrote 5-popup.png');

  // ---- Small promo tile, 440x280. Its own context for the different aspect ratio.
  const tileCtx = await chromium.launchPersistentContext(
    mkdtempSync(path.join(tmpdir(), 'jic-tile-')),
    { headless: true, viewport: TILE, deviceScaleFactor: 2, args: ['--hide-scrollbars'] }
  );
  const tile = await tileCtx.newPage();
  // The icon has to be inlined: a setContent page cannot load file:// subresources,
  // and an earlier version rendered Chrome's broken-image glyph instead.
  const iconData = readFileSync(path.join(ROOT, 'assets/icons/icon128.png')).toString('base64');
  await tile.setContent(`
    <style>
      html,body{margin:0;height:100%}
      body{display:flex;align-items:center;gap:18px;justify-content:center;
           background:#632889;color:#fff;
           font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      img{width:68px;height:68px;flex:none}
      h1{font-size:22px;margin:0 0 4px;font-weight:650;letter-spacing:-.015em;line-height:1.15}
      p{font-size:12px;margin:0;opacity:.85;line-height:1.4}
    </style>
    <img src="data:image/png;base64,${iconData}">
    <div><h1>Japanese in Color</h1><p>Every word colored by<br>its part of speech</p></div>
  `);
  await tile.waitForTimeout(600);
  await tile.screenshot({ path: path.join(OUT, 'promo-tile-440x280.png') });
  shots.push(path.join(OUT, 'promo-tile-440x280.png'));
  console.log('  wrote promo-tile-440x280.png');
  await tileCtx.close();
} finally {
  await context.close();
  server.close();
  rmSync(extDir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}

// Verify every output is exactly the size the store expects, by parsing the IHDR.
console.log('\nverifying dimensions');
let bad = 0;
for (const f of readdirSync(OUT).filter(f => f.endsWith('.png')).sort()) {
  const buf = readFileSync(path.join(OUT, f));
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const want = f.startsWith('promo-tile') ? [440, 280] : [1280, 800];
  const ok = w === want[0] && h === want[1];
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${f}  ${w}x${h}${ok ? '' : `  expected ${want.join('x')}`}`);
}
if (bad) process.exitCode = 1;
