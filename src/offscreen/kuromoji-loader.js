// Builds a kuromoji tokenizer once. Dict files live in assets/kuromoji-dict/
// (copied from node_modules at build time). The @patdx/kuromoji browser
// loader does NOT decompress gzip, so we wrap with DecompressionStream.

import { TokenizerBuilder } from '@patdx/kuromoji';

class KaigiLoader {
  async loadArrayBuffer(filename) {
    const url = chrome.runtime.getURL(`assets/kuromoji-dict/${filename}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`kuromoji fetch ${filename}: ${res.status}`);
    const ds = new DecompressionStream('gzip');
    const stream = res.body.pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }
}

let tokenizerPromise = null;

export function ensureTokenizer() {
  if (!tokenizerPromise) {
    const builder = new TokenizerBuilder({ loader: new KaigiLoader() });
    tokenizerPromise = builder.build();
  }
  return tokenizerPromise;
}
