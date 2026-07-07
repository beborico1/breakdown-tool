// Loads the prebuilt KANJIDIC meaning map (assets/kanjidic/kanji-en.json.gz)
// and exposes a per-character lookup. The map is { kanji: "meaning1; meaning2; meaning3" }.
// Used as a fallback when a standalone single-kanji token has no JMdict word entry.

let mapPromise = null;

async function loadMap() {
  const url = chrome.runtime.getURL('assets/kanjidic/kanji-en.json.gz');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kanjidic fetch failed: ${res.status}`);
  const ds = new DecompressionStream('gzip');
  const decompressed = res.body.pipeThrough(ds);
  const text = await new Response(decompressed).text();
  return JSON.parse(text);
}

export function ensureKanjidic() {
  if (!mapPromise) mapPromise = loadMap();
  return mapPromise;
}

export async function lookupKanji(ch) {
  const map = await ensureKanjidic();
  return (ch && map[ch]) || '';
}
