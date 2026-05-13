// Loads the prebuilt JMdict gloss map (assets/jmdict/jmdict-en.json.gz)
// and exposes a synchronous lookup. The map is { surfaceOrReading: "gloss1; gloss2; gloss3" }.

let mapPromise = null;

async function loadMap() {
  const url = chrome.runtime.getURL('assets/jmdict/jmdict-en.json.gz');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`jmdict fetch failed: ${res.status}`);
  const ds = new DecompressionStream('gzip');
  const decompressed = res.body.pipeThrough(ds);
  const text = await new Response(decompressed).text();
  return JSON.parse(text);
}

export function ensureJmdict() {
  if (!mapPromise) mapPromise = loadMap();
  return mapPromise;
}

export async function lookup(...keys) {
  const map = await ensureJmdict();
  for (const k of keys) {
    if (k && map[k]) return map[k];
  }
  return '';
}
