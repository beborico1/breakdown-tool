// Loads the packed JMdict gloss index (assets/jmdict/jmdict-en.bin.gz) and
// exposes a lookup. See jmdict-index.js for the layout and why it is not JSON.

import { decodeJmdictIndex } from './jmdict-index.js';

let indexPromise = null;

async function loadIndex() {
  const url = chrome.runtime.getURL('assets/jmdict/jmdict-en.bin.gz');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`jmdict fetch failed: ${res.status}`);
  const ds = new DecompressionStream('gzip');
  const decompressed = res.body.pipeThrough(ds);
  const buffer = await new Response(decompressed).arrayBuffer();
  return decodeJmdictIndex(buffer);
}

export function ensureJmdict() {
  if (!indexPromise) indexPromise = loadIndex();
  return indexPromise;
}

export async function lookup(...keys) {
  const index = await ensureJmdict();
  for (const k of keys) {
    if (!k) continue;
    const gloss = index.lookup(k);
    if (gloss) return gloss;
  }
  return '';
}
