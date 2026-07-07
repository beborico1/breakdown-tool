#!/usr/bin/env node
// Build script: copy kuromoji dict files + build a compact JMdict gloss map.
// Idempotent — checks output files and skips if up-to-date.

import { mkdir, cp, stat, writeFile, readFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';
import path from 'node:path';
import os from 'node:os';

const gz = promisify(gzip);
const ROOT = path.resolve(import.meta.dirname, '..');

const KUROMOJI_SRC = path.join(ROOT, 'node_modules/@patdx/kuromoji/dict');
const KUROMOJI_DST = path.join(ROOT, 'assets/kuromoji-dict');
const JMDICT_OUT = path.join(ROOT, 'assets/jmdict/jmdict-en.json.gz');
const JMDICT_TMP_DIR = path.join(os.tmpdir(), 'kaigi-jmdict');
const KANJIDIC_OUT = path.join(ROOT, 'assets/kanjidic/kanji-en.json.gz');
const KANJIDIC_TMP_DIR = path.join(os.tmpdir(), 'kaigi-kanjidic');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function copyKuromoji() {
  await mkdir(KUROMOJI_DST, { recursive: true });
  const files = await readdir(KUROMOJI_SRC);
  for (const f of files) {
    const dst = path.join(KUROMOJI_DST, f);
    if (await exists(dst)) continue;
    await cp(path.join(KUROMOJI_SRC, f), dst);
  }
  console.log(`[assets] kuromoji dict -> ${KUROMOJI_DST}`);
}

async function fetchLatestReleaseAssets() {
  const res = await fetch('https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest');
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const json = await res.json();
  return json.assets || [];
}

function pickAsset(assets, pattern, label) {
  const asset = assets.find(a => pattern.test(a.name));
  if (!asset) throw new Error(`${label} .tgz not found in latest release`);
  return asset.browser_download_url;
}

async function downloadAndExtract(url, tmpDir) {
  await mkdir(tmpDir, { recursive: true });
  console.log(`[assets] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  await pipeline(
    Readable.fromWeb(res.body),
    tar.x({ cwd: tmpDir })
  );
  const files = await readdir(tmpDir);
  const jsonFile = files.find(f => f.endsWith('.json'));
  if (!jsonFile) throw new Error('no .json in extracted archive');
  return path.join(tmpDir, jsonFile);
}

async function buildJmdictMap(jsonPath) {
  console.log(`[assets] parsing ${jsonPath}`);
  const raw = await readFile(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  const map = {};
  let entries = 0, glosses = 0;
  for (const entry of data.words) {
    const kanjiForms = (entry.kanji || []).map(k => k.text);
    const kanaForms = (entry.kana || []).map(k => k.text);
    const senseGlosses = [];
    for (const sense of entry.sense || []) {
      for (const g of sense.gloss || []) {
        if (g.lang === 'eng' || !g.lang) senseGlosses.push(g.text);
      }
      if (senseGlosses.length >= 3) break;
    }
    if (senseGlosses.length === 0) continue;
    const value = senseGlosses.slice(0, 3).join('; ');
    for (const k of [...kanjiForms, ...kanaForms]) {
      if (!map[k]) { map[k] = value; entries++; }
    }
    glosses++;
  }
  console.log(`[assets] jmdict entries: ${entries} keys from ${glosses} words`);
  const jsonOut = JSON.stringify(map);
  const compressed = await gz(Buffer.from(jsonOut, 'utf8'), { level: 9 });
  await mkdir(path.dirname(JMDICT_OUT), { recursive: true });
  await writeFile(JMDICT_OUT, compressed);
  console.log(`[assets] wrote ${JMDICT_OUT} (${(compressed.length / 1024 / 1024).toFixed(1)} MB)`);
}

async function buildKanjidicMap(jsonPath) {
  console.log(`[assets] parsing ${jsonPath}`);
  const raw = await readFile(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  const map = {};
  let entries = 0;
  for (const ch of data.characters || []) {
    const literal = ch.literal;
    if (!literal) continue;
    const meanings = [];
    for (const group of ch.readingMeaning?.groups || []) {
      for (const m of group.meanings || []) {
        if (m.lang === 'en' || !m.lang) meanings.push(m.value);
      }
      if (meanings.length >= 3) break;
    }
    if (meanings.length === 0) continue;
    map[literal] = meanings.slice(0, 3).join('; ');
    entries++;
  }
  console.log(`[assets] kanjidic entries: ${entries} kanji`);
  const compressed = await gz(Buffer.from(JSON.stringify(map), 'utf8'), { level: 9 });
  await mkdir(path.dirname(KANJIDIC_OUT), { recursive: true });
  await writeFile(KANJIDIC_OUT, compressed);
  console.log(`[assets] wrote ${KANJIDIC_OUT} (${(compressed.length / 1024).toFixed(0)} KB)`);
}

async function buildDictionaries() {
  const jmdictDone = await exists(JMDICT_OUT);
  const kanjidicDone = await exists(KANJIDIC_OUT);
  if (jmdictDone && kanjidicDone) {
    console.log('[assets] jmdict + kanjidic already built (delete the .gz files to rebuild)');
    return;
  }
  const assets = await fetchLatestReleaseAssets();
  if (jmdictDone) {
    console.log(`[assets] jmdict already built (delete ${JMDICT_OUT} to rebuild)`);
  } else {
    const url = pickAsset(assets, /^jmdict-eng-\d.+\.json\.tgz$/, 'jmdict-eng');
    const jsonPath = await downloadAndExtract(url, JMDICT_TMP_DIR);
    await buildJmdictMap(jsonPath);
  }
  if (kanjidicDone) {
    console.log(`[assets] kanjidic already built (delete ${KANJIDIC_OUT} to rebuild)`);
  } else {
    const url = pickAsset(assets, /^kanjidic2-en-\d.+\.json\.tgz$/, 'kanjidic2-en');
    const jsonPath = await downloadAndExtract(url, KANJIDIC_TMP_DIR);
    await buildKanjidicMap(jsonPath);
  }
}

await copyKuromoji();
await buildDictionaries();
console.log('[assets] done');
