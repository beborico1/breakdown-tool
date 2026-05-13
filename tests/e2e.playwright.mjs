#!/usr/bin/env node
// Headed Playwright test for the offline NLP pipeline.
//
// Loads the unpacked extension into Chromium, opens the extension's popup
// page (any extension page works — we just need a runtime context that can
// chrome.runtime.sendMessage), enables the offline NLP flag, and asks the
// service-worker proxy to run an analyze + translate. Asserts the response
// contains correctly typed words for sample Japanese.
//
// The Chrome built-in Translator API may not be available in stock Chromium;
// translation is therefore best-effort (test passes even if translation is
// empty, as long as breakdown is correct).

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, info) { console.log(`  ✗ ${n}`); if (info) console.log(`     ${info}`); fail++; }
function assertEq(n, a, e) { a === e ? ok(n) : bad(n, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function assertGte(n, a, e) { a >= e ? ok(n) : bad(n, `expected >=${e}, got ${a}`); }
function assertIncludes(n, c, needle) { String(c || '').includes(needle) ? ok(n) : bad(n, `expected to include "${needle}", got ${JSON.stringify(c)}`); }

const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'kaigi-e2e-'));

console.log(`Launching Chromium with extension from ${EXT_DIR}`);


console.log(`User profile: ${userDataDir}`);

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run',
  ],
});

context.on('page', (p) => {
  if (p.url().includes('offscreen.html')) {
    console.log('[ctx] offscreen page opened:', p.url());
    p.on('console', (m) => console.log(`  [offscreen ${m.type()}] ${m.text()}`));
    p.on('pageerror', (err) => console.log(`  [offscreen error] ${err.message}`));
  }
});
context.on('serviceworker', (sw) => {
  console.log('[ctx] serviceworker:', sw.url());
});

try {
  console.log('Opening a blank page to keep the context alive...');
  const blank = await context.newPage();
  await blank.goto('about:blank');

  // Wait for the service worker to register (extension boot).
  console.log('Waiting for extension service worker...');
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await Promise.race([
      context.waitForEvent('serviceworker', { timeout: 15000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('serviceworker timeout')), 15000)),
    ]);
  }
  const extId = worker.url().split('/')[2];
  console.log(`Extension ID: ${extId}\n`);

  console.log('Opening popup page for runtime access...');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/src/pages/popup/popup.html`);
  await page.waitForLoadState('domcontentloaded');
  page.on('console', m => console.log(`  [page ${m.type()}] ${m.text()}`));

  // Flip the offline-NLP flag on.
  await page.evaluate(() => new Promise((r) => chrome.storage.sync.set({ useOfflineNlp: true }, r)));

  // Warm up offscreen (creates the document and loads kuromoji + jmdict).
  console.log('Warming up offscreen NLP (loading kuromoji + JMdict)...');
  const warm = await page.evaluate(() => new Promise((r) => {
    chrome.runtime.sendMessage({ type: 'kaigi-nlp-proxy', op: 'warmup', text: '' }, r);
  }));
  if (!warm?.ok) {
    bad('warmup', warm?.error || 'no response');
    throw new Error('warmup failed');
  }
  ok('warmup');

  // ---- Test: 私は学生です ----
  console.log('\nTest: analyze 私は学生です');
  const r1 = await page.evaluate(() => new Promise((r) => {
    const timer = setTimeout(() => r({ ok: false, error: 'timeout 20s' }), 20000);
    chrome.runtime.sendMessage({ type: 'kaigi-nlp-proxy', op: 'analyze', text: '私は学生です' }, (resp) => { clearTimeout(timer); r(resp); });
  }));
  if (!r1?.ok) { bad('response ok', r1?.error || 'no response'); }
  else {
    ok('response ok');
    const w = r1.result.words;
    assertGte('returned >=4 words', w.length, 4);
    const m = Object.fromEntries(w.map(x => [x.japanese, x]));
    assertEq('私 type=noun', m['私']?.type, 'noun');
    assertEq('は type=particle', m['は']?.type, 'particle');
    assertEq('は label=topic marker', m['は']?.english, 'topic marker');
    assertEq('学生 type=noun', m['学生']?.type, 'noun');
    assertIncludes('学生 gloss includes student', m['学生']?.english, 'student');
    assertEq('です type=copula', m['です']?.type, 'copula');
    console.log(`  translation: ${JSON.stringify(r1.result.translation || '(empty — Translator API unavailable)')}`);
  }

  // ---- Test: 寿司を食べました ----
  console.log('\nTest: analyze 寿司を食べました');
  const r2 = await page.evaluate(() => new Promise((r) => {
    const timer = setTimeout(() => r({ ok: false, error: 'timeout 20s' }), 20000);
    chrome.runtime.sendMessage({ type: 'kaigi-nlp-proxy', op: 'analyze', text: '寿司を食べました' }, (resp) => { clearTimeout(timer); r(resp); });
  }));
  if (!r2?.ok) { bad('response ok', r2?.error); }
  else {
    const w = r2.result.words;
    const sushi = w.find(x => x.japanese === '寿司');
    const wo = w.find(x => x.japanese === 'を');
    const verb = w.find(x => x.type === 'verb');
    assertIncludes('寿司 gloss includes sushi', sushi?.english, 'sushi');
    assertEq('を label=object marker', wo?.english, 'object marker');
    assertEq('found a verb', Boolean(verb), true);
    assertIncludes('verb gloss includes eat', verb?.english, 'eat');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

process.exit(fail > 0 ? 1 : 0);
