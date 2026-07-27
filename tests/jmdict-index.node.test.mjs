/**
 * JMdict packed index: round-trip correctness and heap cost.
 *
 * The gloss map used to ship as JSON and be JSON.parse'd into a 462k-key plain
 * object in the offscreen document. It is now three flat buffers with a binary
 * search over UTF-8 keys. These tests check nothing is lost in the repack, that
 * the sort order lookup depends on actually holds in the shipped file, and that
 * the heap cost really did drop.
 *
 * Run: node tests/jmdict-index.node.test.mjs
 */

import { readFile } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeJmdictIndex, decodeJmdictIndex } from '../src/offscreen/jmdict-index.js';

const gunzipAsync = promisify(gunzip);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}

/** Node Buffers sit at arbitrary byteOffsets; the Uint32Array views need alignment. */
function toAlignedArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ------------------------------------------------------------- round trip

console.log('round trip preserves every entry:');
{
  const map = {
    '会議': 'meeting; conference',
    '日本語': 'Japanese (language)',
    'はなれ': 'detached; separate',
    '離れ': 'detached; outbuilding',
    'a': 'lowercase ascii',
    'Z': 'uppercase ascii',
    '': 'empty key',
    'ドキュメント': 'document',
    '𠮟る': 'to scold',                       // supplementary plane (surrogate pair)
    '𩸽': 'okhotsk atka mackerel',            // supplementary plane
    'とてもながいひらがなのキーワードですね': 'a very long key',
    'punct;: gloss': 'value with ; and :',
  };

  const packed = encodeJmdictIndex(map);
  const index = decodeJmdictIndex(toAlignedArrayBuffer(Buffer.from(packed)));

  check('entry count matches', index.count === Object.keys(map).length,
    `${index.count} vs ${Object.keys(map).length}`);

  let wrong = 0;
  for (const [k, v] of Object.entries(map)) {
    if (k === '') continue; // lookup('') is defined to return '' — covered below
    if (index.lookup(k) !== v) {
      wrong++;
      console.log(`       ${JSON.stringify(k)} -> ${JSON.stringify(index.lookup(k))}, want ${JSON.stringify(v)}`);
    }
  }
  check('every key returns its exact gloss', wrong === 0, `${wrong} wrong`);
  check('supplementary-plane key survives', index.lookup('𠮟る') === 'to scold');
  check('missing key returns empty string', index.lookup('存在しない語') === '');
  check('empty probe returns empty string', index.lookup('') === '');
}

// ------------------------------------------------- shipped file integrity

console.log('the shipped index is internally consistent:');
{
  const gz = await readFile(path.join(ROOT, 'assets/jmdict/jmdict-en.bin.gz'));
  const raw = await gunzipAsync(gz);
  const buffer = toAlignedArrayBuffer(raw);

  const before = process.memoryUsage();
  const index = decodeJmdictIndex(buffer);
  const after = process.memoryUsage();

  check('has the full dictionary', index.count > 400000, `count ${index.count}`);

  // Sort order is the precondition for binary search: if it does not hold, some
  // keys become unreachable and glosses silently go missing.
  const encoder = new TextEncoder();
  let outOfOrder = 0;
  let prev = null;
  const step = Math.max(1, Math.floor(index.count / 50000));
  for (let i = 0; i < index.count; i += step) {
    const cur = encoder.encode(index.keyAt(i));
    if (prev) {
      let cmp = 0;
      const n = Math.min(prev.length, cur.length);
      for (let j = 0; j < n; j++) { if (prev[j] !== cur[j]) { cmp = prev[j] - cur[j]; break; } }
      if (cmp === 0) cmp = prev.length - cur.length;
      if (cmp >= 0) outOfOrder++;
    }
    prev = cur;
  }
  check('keys are strictly ascending in UTF-8 byte order', outOfOrder === 0,
    `${outOfOrder} inversions`);

  // Every key must be findable by the same search the runtime uses.
  let unreachable = 0;
  for (let i = 0; i < index.count; i += step) {
    if (index.lookup(index.keyAt(i)) === '') unreachable++;
  }
  check('every sampled key is reachable via lookup', unreachable === 0,
    `${unreachable} unreachable`);

  check('known entries resolve', index.lookup('離れ').includes('detached') &&
    index.lookup('はなれ').length > 0 && index.lookup('会議').length > 0);

  // decodeJmdictIndex only lays typed-array views over the buffer, so the cost
  // is the buffer itself — off-heap (V8 "external"), not heapUsed. The JSON
  // build's 60.4 MB by contrast was all V8 heap: 462k object properties.
  const heapMb = (after.heapUsed - before.heapUsed) / 1048576;
  const residentMb = raw.byteLength / 1048576;
  console.log(`       ${index.count.toLocaleString()} entries: ${residentMb.toFixed(1)} MB of ArrayBuffer ` +
    `+ ${heapMb.toFixed(1)} MB V8 heap (the JSON build cost 60.4 MB of V8 heap)`);
  check('the views add essentially no heap of their own', heapMb < 1,
    `${heapMb.toFixed(1)} MB`);
  check('total resident cost is well under the JSON build', residentMb < 35,
    `${residentMb.toFixed(1)} MB`);
}

console.log(failures === 0 ? '\nAll jmdict-index tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
