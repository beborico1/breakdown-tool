#!/usr/bin/env node
// Packaging script: build, then assemble a Chrome Web Store zip from a computed
// allowlist.
//
// Why a computed allowlist rather than `zip -r ... src/`: globbing src/ shipped
// every scratch fixture in the tree, including a captured chat DOM containing a
// colleague's email address. It also shipped only assets/icons/, omitting the
// dictionaries the on-device pipeline fetches at runtime — so the packaged
// extension 404'd on its first analysis.
//
// The file set is derived, not maintained by hand: from the manifest and the
// extension pages we walk every ES import and every stylesheet reference, and
// take the transitive closure. A module nothing reaches cannot end up in the
// package, and a module something reaches cannot be forgotten.

import { mkdir, stat, readFile, readdir, rm, cp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const STAGE = path.join(ROOT, 'build');

/**
 * Extension pages that code opens directly (chrome.tabs.create / createDocument)
 * rather than the manifest referencing them. The manifest-referenced ones are
 * discovered automatically; these are the ones only a string literal knows about.
 */
const CODE_OPENED_PAGES = [
  'src/pages/welcome/welcome.html',
  'src/pages/frequency/frequency.html',
  'src/pages/transcribe/transcribe.html',
  'src/offscreen/offscreen.html',
];

/**
 * Files loaded by a mechanism no static analysis can see. Each needs a reason;
 * an entry without one is how unused weight creeps back in.
 */
const DYNAMIC_EXTRAS = [];

/** Asset directories shipped wholesale. */
const ASSET_DIRS = ['assets/icons', 'assets/kuromoji-dict', 'assets/jmdict', 'assets/kanjidic'];

const ALWAYS = ['manifest.json', 'LICENSE'];

/**
 * Nothing matching these may appear in the staged tree. This is the backstop
 * for the failure that actually happened: a confidential fixture riding along
 * inside a directory that was globbed wholesale.
 */
const DENY = [
  { re: /\.md$/i, why: 'documentation / scratch notes' },
  { re: /\.txt$/i, why: 'transcripts and scratch text' },
  { re: /\.zip$/i, why: 'nested archive' },
  { re: /\.DS_Store$/i, why: 'macOS metadata' },
  { re: /sample\.html$/i, why: 'captured page fixture (may contain real user data)' },
  { re: /(^|\/)tests?\//i, why: 'test code' },
  { re: /(^|\/)node_modules\//, why: 'dependencies' },
  { re: /\.map$/i, why: 'source map' },
];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function fail(msg) {
  console.error(`\n[package] REFUSING TO PACKAGE\n  ${msg}\n`);
  process.exit(1);
}

/** Resolve an import specifier against the importing file, adding .js if needed. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;      // bare specifier: bundled, not shipped raw
  const abs = path.resolve(path.dirname(fromFile), spec);
  return abs;
}

const IMPORT_RE = /(?:^|\s)(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every relative ES import in a JS source file. */
function importsOf(src) {
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (spec) out.push(spec);
  }
  return out;
}

const HTML_REF_RE = /(?:src|href)\s*=\s*['"]([^'"]+)['"]/g;

/** Local src/href references in an HTML file (scripts, stylesheets). */
function refsOf(html) {
  const out = [];
  for (const m of html.matchAll(HTML_REF_RE)) {
    const ref = m[1];
    if (ref.startsWith('http') || ref.startsWith('//') || ref.startsWith('#') || ref.startsWith('data:')) continue;
    out.push(ref);
  }
  return out;
}

/**
 * Walk from the entry points and collect every reachable file.
 * @returns {Promise<Set<string>>} repo-relative paths
 */
async function collectClosure(entries) {
  const seen = new Set();
  const queue = [...entries.map(e => path.join(ROOT, e))];

  while (queue.length) {
    const abs = queue.pop();
    const rel = path.relative(ROOT, abs);
    if (seen.has(rel)) continue;
    if (!(await exists(abs))) fail(`referenced file does not exist: ${rel}`);
    seen.add(rel);

    const ext = path.extname(abs);
    if (ext === '.js' || ext === '.mjs') {
      const src = await readFile(abs, 'utf8');
      for (const spec of importsOf(src)) {
        const target = resolveImport(abs, spec);
        if (target) queue.push(target);
      }
    } else if (ext === '.html') {
      const html = await readFile(abs, 'utf8');
      for (const ref of refsOf(html)) {
        queue.push(path.resolve(path.dirname(abs), ref));
      }
    }
  }
  return seen;
}

/** Every file under a directory, repo-relative. */
async function walkDir(rel) {
  const out = [];
  const abs = path.join(ROOT, rel);
  for (const entry of await readdir(abs, { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...await walkDir(child));
    else out.push(child);
  }
  return out;
}

async function main() {
  // 1. Versions must agree. A mismatch means the store item and the code
  //    disagree about what was shipped, which is unfixable after the fact.
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
  if (pkg.version !== manifest.version) {
    fail(`version mismatch: package.json ${pkg.version} vs manifest.json ${manifest.version}`);
  }
  const version = manifest.version;

  // 2. Build. Never package a stale dist/.
  console.log('[package] building…');
  await exec('npm', ['run', 'build'], { cwd: ROOT, maxBuffer: 1024 * 1024 * 32 });

  // 3. Derive the entry points from the manifest, then take the closure.
  const entries = [...ALWAYS, ...CODE_OPENED_PAGES, ...DYNAMIC_EXTRAS.map(e => e.file)];
  if (manifest.background?.service_worker) entries.push(manifest.background.service_worker);
  if (manifest.action?.default_popup) entries.push(manifest.action.default_popup);
  for (const cs of manifest.content_scripts || []) {
    entries.push(...(cs.js || []), ...(cs.css || []));
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const res of war.resources || []) {
      if (!res.includes('*')) entries.push(res);   // globs are covered by ASSET_DIRS
    }
  }

  const files = await collectClosure(entries);
  for (const dir of ASSET_DIRS) {
    if (!(await exists(path.join(ROOT, dir)))) fail(`missing asset directory ${dir} — run npm run build`);
    for (const f of await walkDir(dir)) files.add(f);
  }

  // 4. The dictionaries are what the default pipeline needs at runtime, and
  //    their absence is silent until a user's first analysis 404s.
  const dictProbes = ['assets/jmdict', 'assets/kuromoji-dict', 'assets/kanjidic'];
  for (const dir of dictProbes) {
    const n = [...files].filter(f => f.startsWith(dir + '/')).length;
    if (n === 0) fail(`no files staged from ${dir} — the on-device pipeline would 404 on first use`);
  }

  // 5. Denylist over the exact set about to ship.
  const violations = [];
  for (const f of files) {
    for (const { re, why } of DENY) {
      if (re.test(f)) violations.push(`${f}  (${why})`);
    }
  }
  if (violations.length) {
    fail(`denylisted files reached the package:\n    ${violations.join('\n    ')}`);
  }

  // 6. Stage.
  await rm(STAGE, { recursive: true, force: true });
  const sorted = [...files].sort();
  for (const f of sorted) {
    const dst = path.join(STAGE, f);
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(path.join(ROOT, f), dst);
  }

  // 7. Zip.
  const zipName = `japanese-in-color-v${version}.zip`;
  const zipPath = path.join(ROOT, zipName);
  await rm(zipPath, { force: true });
  await exec('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: STAGE });

  // 8. Report, so the contents are eyeballed rather than trusted.
  const bytes = await Promise.all(sorted.map(async f => (await stat(path.join(STAGE, f))).size));
  const total = bytes.reduce((a, b) => a + b, 0);
  const zipSize = (await stat(zipPath)).size;

  // Group by the first two path segments (assets/jmdict, src/content, …) so the
  // report is short enough to actually read, with loose files kept individually.
  const byTop = new Map();
  sorted.forEach((f, i) => {
    const parts = f.split('/');
    const key = parts.length > 1 ? parts.slice(0, 2).join('/') : f;
    byTop.set(key, (byTop.get(key) || 0) + bytes[i]);
  });

  console.log(`\n[package] ${sorted.length} files, ${(total / 1024 / 1024).toFixed(1)} MB unpacked`);
  for (const [group, size] of [...byTop].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(size / 1024).toFixed(0).padStart(8)} KB  ${group}`);
  }
  console.log(`\n[package] wrote ${zipName} (${(zipSize / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`[package] staged tree at build/ — load it unpacked to smoke-test the real package`);
}

await main();
