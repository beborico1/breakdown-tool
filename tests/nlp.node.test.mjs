#!/usr/bin/env node
// Node-side test for the NLP pipeline: kuromoji tokenization + POS mapping +
// JMdict lookup + wanakana romaji. Does NOT cover the Chrome Translator API
// (browser-only) — that's exercised by the Playwright test.

import { TokenizerBuilder } from '@patdx/kuromoji';
import NodeDictionaryLoader from '@patdx/kuromoji/node';
import { toRomaji } from 'wanakana';
import { readFile } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { mapPOS } from '../src/offscreen/pos-map.js';

const gunzipAsync = promisify(gunzip);
const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, info) { console.log(`  ✗ ${name}`); if (info) console.log(`     ${info}`); fail++; }

function assertEq(name, actual, expected) {
  if (actual === expected) ok(name);
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(name, container, needle) {
  if (String(container || '').includes(needle)) ok(name);
  else bad(name, `expected to include "${needle}", got ${JSON.stringify(container)}`);
}

function kataToHira(s) {
  if (!s) return '';
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCharCode(code + (0x3041 - 0x30a1));
    else out += ch;
  }
  return out;
}

console.log('Loading kuromoji + JMdict...');
const tokenizer = await new TokenizerBuilder({
  loader: new NodeDictionaryLoader({ dic_path: path.join(ROOT, 'node_modules/@patdx/kuromoji/dict') }),
}).build();
const jmdictGz = await readFile(path.join(ROOT, 'assets/jmdict/jmdict-en.json.gz'));
const jmdict = JSON.parse((await gunzipAsync(jmdictGz)).toString('utf8'));
console.log(`Loaded ${Object.keys(jmdict).length} JMdict entries\n`);

function analyze(text) {
  const tokens = tokenizer.tokenize(text);
  const words = [];
  for (const t of tokens) {
    if (/^[\s\p{P}\p{S}]+$/u.test(t.surface_form)) continue;
    const { type, label } = mapPOS(t);
    const readingKata = t.reading && t.reading !== '*' ? t.reading : '';
    const basic = t.basic_form && t.basic_form !== '*' ? t.basic_form : null;
    const english = label || jmdict[basic] || jmdict[t.surface_form] || jmdict[kataToHira(readingKata)] || '';
    words.push({
      japanese: t.surface_form,
      reading: /[一-龯]/.test(t.surface_form) ? kataToHira(readingKata) : '',
      romaji: toRomaji(readingKata || t.surface_form).toLowerCase(),
      english,
      type,
      _basic: basic,
    });
  }
  return words;
}

console.log('Test 1: 私は学生です');
{
  const w = analyze('私は学生です');
  const map = Object.fromEntries(w.map(x => [x.japanese, x]));
  assertEq('私 is noun', map['私']?.type, 'noun');
  assertEq('私 reading is わたし', map['私']?.reading, 'わたし');
  assertEq('私 romaji is watashi', map['私']?.romaji, 'watashi');
  assertEq('は is particle', map['は']?.type, 'particle');
  assertEq('は label is topic marker', map['は']?.english, 'topic marker');
  assertEq('学生 is noun', map['学生']?.type, 'noun');
  assertIncludes('学生 gloss includes student', map['学生']?.english, 'student');
  assertEq('です is copula', map['です']?.type, 'copula');
}

console.log('\nTest 2: 寿司を食べました (conjugated verb)');
{
  const w = analyze('寿司を食べました');
  const map = Object.fromEntries(w.map(x => [x.japanese, x]));
  assertEq('寿司 is noun', map['寿司']?.type, 'noun');
  assertIncludes('寿司 gloss includes sushi', map['寿司']?.english, 'sushi');
  assertEq('を is particle', map['を']?.type, 'particle');
  assertEq('を label is object marker', map['を']?.english, 'object marker');
  const taberu = w.find(x => x._basic === '食べる');
  assertEq('食べる lemma found', Boolean(taberu), true);
  assertEq('食べる is verb', taberu?.type, 'verb');
  assertIncludes('食べる gloss includes eat', taberu?.english, 'eat');
}

console.log('\nTest 3: 今日はとても暑いです (adjective + adverb)');
{
  const w = analyze('今日はとても暑いです');
  const map = Object.fromEntries(w.map(x => [x.japanese, x]));
  assertEq('とても is adverb', map['とても']?.type, 'adverb');
  // 暑い tokenized as a single 形容詞 or stem+aux; check at least one adjective
  const hasAdj = w.some(x => x.type === 'adjective');
  assertEq('contains an adjective', hasAdj, true);
}

console.log('\nTest 4: empty input');
{
  const w = analyze('');
  assertEq('empty input returns empty array', w.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
