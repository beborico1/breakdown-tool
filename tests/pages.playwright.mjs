#!/usr/bin/env node
// Loads the real extension into Chromium and opens each extension page, to catch
// the class of breakage that neither the build nor the DOM tests can see: a
// script that throws on load, an element id the JS queries but the markup no
// longer has, or an asset path that 404s.
//
// Runs headed for the same reason tests/e2e.playwright.mjs does — Chromium will
// not load an MV3 extension in headless mode.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// Prefer the packaged tree when it exists: that is what users actually install,
// and it is where a missing-from-the-package file shows up.
const EXT_DIR = existsSync(path.join(ROOT, 'build', 'manifest.json'))
  ? path.join(ROOT, 'build')
  : ROOT;

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, info) { console.log(`  ✗ ${n}`); if (info) console.log(`     ${info}`); fail++; }
function assertEq(n, a, e) {
  a === e ? ok(n) : bad(n, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(n, v, info) { v ? ok(n) : bad(n, info || `expected truthy, got ${JSON.stringify(v)}`); }

const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'kaigi-pages-'));
console.log(`Loading extension from ${EXT_DIR}`);

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;

  /** Open a page and collect anything it logs as an error or throws. */
  async function open(rel, settleMs = 1500) {
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(String(e.message)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', r => errors.push(`request failed: ${r.url()}`));
    await page.goto(`chrome-extension://${extId}/${rel}`);
    await page.waitForTimeout(settleMs);
    return { page, errors };
  }

  // ---- popup
  console.log('\nPopup');
  const { page: popup, errors: popupErrors } = await open('src/pages/popup/popup.html');
  assertEq('title is the product name', await popup.title(), 'Japanese in Color');
  assertEq('heading is not Meet-specific', await popup.textContent('h1'), 'Japanese in Color');
  assertEq('the colorizer is the hero', await popup.textContent('.hero-title'),
    'Color Japanese on every website');
  assertTrue('the all-sites permission is explained before it is requested',
    await popup.isVisible('#heroAsk'));
  assertEq('ships switched off', await popup.isChecked('#universalModeToggle'), false);
  assertTrue('Meet controls are hidden off Meet', !(await popup.isVisible('#meetCard')));
  assertEq('two tools are offered',
    (await popup.$$eval('.tool-title', ns => ns.map(n => n.textContent.trim()))).join('|'),
    'Your words|Speak & check');
  assertTrue('the toolbar icon resolves',
    await popup.$eval('.pop-logo', img => img.complete && img.naturalWidth > 0));
  // Every removed feature must be gone from the markup, not merely hidden.
  const popupHtml = await popup.content();
  for (const gone of ['apiKey', 'modelSelect', 'tokenCount', 'customSiteUrl', 'offlineNlpToggle']) {
    assertTrue(`no leftover #${gone}`, !popupHtml.includes(`id="${gone}"`));
  }
  assertEq('popup loads without errors', popupErrors.join(' | '), '');

  // ---- welcome
  console.log('\nWelcome');
  const { page: welcome, errors: welcomeErrors } = await open('src/pages/welcome/welcome.html', 4000);
  assertEq('welcome titled', await welcome.textContent('h1'), 'Japanese in Color');
  assertTrue('hero art resolves',
    await welcome.$eval('.hero-icon', img => img.complete && img.naturalWidth > 0));
  assertEq('the colour legend is rendered', await welcome.$$eval('.legend li', ns => ns.length), 8);
  // The legend takes its colours from content.css via the same .gcwb-type-*
  // classes the painter uses, so this also proves the stylesheet is linked.
  assertEq('legend colours come from the real stylesheet',
    await welcome.$eval('.legend-swatch.gcwb-type-noun', el => getComputedStyle(el).color),
    'rgb(66, 133, 244)');
  assertEq('welcome loads without errors', welcomeErrors.join(' | '), '');

  // ---- the other two extension pages
  console.log('\nOther pages');
  const { errors: freqErrors } = await open('src/pages/frequency/frequency.html', 2000);
  assertEq('frequency page loads without errors', freqErrors.join(' | '), '');
  const { page: tr, errors: trErrors } = await open('src/pages/transcribe/transcribe.html', 2000);
  assertTrue('the microphone disclosure is present and unmissable',
    (await tr.textContent('.disclosure')).includes('sent to Google'));
  assertTrue('no API-key warning survives', !(await tr.$('#warningNoKey')));
  assertTrue('no transcription mode picker survives', !(await tr.$('#modeToggle')));
  assertEq('transcribe page loads without errors', trErrors.join(' | '), '');
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
