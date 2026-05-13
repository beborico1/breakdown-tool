// Chrome built-in Translator API wrapper (ja -> en). Lazy-creates the
// translator instance. If the API is unavailable (older Chrome) or the
// model can't be downloaded, throws so the caller can fall back.

let jaEnPromise = null;

async function createJaEn() {
  // Chrome exposes `Translator` as a global in Window contexts (incl. offscreen).
  if (typeof Translator === 'undefined') {
    throw new Error('Translator API unavailable (Chrome 131+ required)');
  }
  const availability = await Translator.availability({
    sourceLanguage: 'ja',
    targetLanguage: 'en',
  });
  if (availability === 'unavailable') {
    throw new Error('ja->en translator unavailable on this device');
  }
  const t = await Translator.create({
    sourceLanguage: 'ja',
    targetLanguage: 'en',
  });
  if (t.ready) await t.ready;
  return t;
}

export function ensureJaEnTranslator() {
  if (!jaEnPromise) jaEnPromise = createJaEn();
  return jaEnPromise;
}

export async function translateJaEn(text) {
  const t = await ensureJaEnTranslator();
  return t.translate(text);
}
