// Chrome built-in Translator API wrapper (ja -> en).
//
// Recent Chrome (138+) only downloads the model when Translator.create() is
// called with a `monitor` callback. We expose:
//   - ensureJaEnTranslator() — lazily kicks off the download and resolves
//     when the instance is usable
//   - translateJaEn(text) — convenience wrapper
//   - getTranslatorState() — sync snapshot for popup UI

let jaEnPromise = null;
const state = {
  availability: 'unknown',   // 'unavailable' | 'downloadable' | 'downloading' | 'available' | 'unknown'
  downloadPct: 0,            // 0..100
  ready: false,
  error: null,
};

function broadcastProgress() {
  try {
    chrome.runtime.sendMessage({ type: 'kaigi-translator-progress', state }).catch?.(() => {});
  } catch {}
}

async function createJaEn() {
  if (typeof Translator === 'undefined') {
    state.availability = 'unavailable';
    state.error = 'Translator API unavailable (Chrome 138+ required)';
    broadcastProgress();
    throw new Error(state.error);
  }
  try {
    state.availability = await Translator.availability({
      sourceLanguage: 'ja',
      targetLanguage: 'en',
    });
  } catch (e) {
    state.availability = 'unavailable';
    state.error = String(e?.message || e);
    broadcastProgress();
    throw e;
  }
  if (state.availability === 'unavailable') {
    state.error = 'ja->en translator unavailable on this device';
    broadcastProgress();
    throw new Error(state.error);
  }
  broadcastProgress();

  const t = await Translator.create({
    sourceLanguage: 'ja',
    targetLanguage: 'en',
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        // e.loaded is 0..1 per the spec
        state.availability = 'downloading';
        state.downloadPct = Math.round((Number(e.loaded) || 0) * 100);
        broadcastProgress();
      });
    },
  });
  if (t.ready) {
    try { await t.ready; } catch (e) {
      state.error = String(e?.message || e);
      broadcastProgress();
      throw e;
    }
  }
  state.availability = 'available';
  state.downloadPct = 100;
  state.ready = true;
  state.error = null;
  broadcastProgress();
  return t;
}

export function ensureJaEnTranslator() {
  if (!jaEnPromise) {
    jaEnPromise = createJaEn().catch((e) => {
      // Allow retry on a later call by clearing the cached failed promise.
      jaEnPromise = null;
      throw e;
    });
  }
  return jaEnPromise;
}

export async function translateJaEn(text) {
  const t = await ensureJaEnTranslator();
  return t.translate(text);
}

export function getTranslatorState() {
  return { ...state };
}
