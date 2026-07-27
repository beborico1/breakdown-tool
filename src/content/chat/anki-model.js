// Custom Anki note type used by the right-click "Add to Anki" flow.
// Auto-created via AnkiConnect on first use. Styled to mirror WaniKani:
// big Japanese surface form on a POS-tinted background, reading + meaning
// on the back.

export const ANKI_MODEL_NAME = 'JapaneseInColor';

/** Default deck for new users. Exported so nothing hard-codes it a second time. */
export const ANKI_DECK_NAME = 'Japanese in Color';

/**
 * Note types this extension created, current and historical.
 *
 * A card written before the 2.0 rename still carries the old note type, and the
 * rich field layout is chosen by matching on it — so dropping the old name would
 * silently downgrade those cards to a plain Front/Back render.
 */
const LEGACY_MODEL_NAMES = ['Kaigi'];
export function isOurModel(name) {
  return name === ANKI_MODEL_NAME || LEGACY_MODEL_NAMES.includes(name);
}

export const ANKI_FIELDS = ['Word', 'Reading', 'Meaning', 'POS'];

// POS colors mirror src/content/content.css (.gcwb-type-*).
const ANKI_CSS = `
.card {
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Hiragino Sans", "Yu Gothic", sans-serif;
  text-align: center;
  color: #fff;
  background: #2b2b2b;
  margin: 0;
  padding: 0;
}
.kaigi-hero {
  width: 100%;
  padding: 56px 24px;
  background: #6b6b6b;
  display: flex;
  align-items: center;
  justify-content: center;
}
.kaigi-word {
  font-size: 96px;
  line-height: 1.1;
  font-weight: 500;
  color: #fff;
  text-shadow: 0 2px 4px rgba(0,0,0,0.15);
}
.kaigi-label {
  background: #ececec;
  color: #333;
  font-size: 22px;
  padding: 14px 8px;
}
.kaigi-label b { font-weight: 700; }
.kaigi-type {
  background: #3a3a3a;
  padding: 18px 16px;
  text-align: center;
}
.kaigi-type input {
  width: 70%;
  max-width: 520px;
  font-size: 24px;
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px solid #555;
  background: #1f1f1f;
  color: #fff;
  text-align: center;
}
.kaigi-type code#typeans {
  display: inline-block;
  font-size: 26px;
  padding: 6px 10px;
  background: transparent;
}
.kaigi-answer {
  padding: 24px 20px;
  color: #f5f5f5;
}
.kaigi-meaning-label {
  font-size: 14px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #aaa;
  margin-bottom: 6px;
}
.kaigi-meaning {
  font-size: 28px;
  color: #fff;
}
.pos-noun       .kaigi-hero { background: #4285F4; }
.pos-verb       .kaigi-hero { background: #34A853; }
.pos-particle   .kaigi-hero { background: #EA4335; }
.pos-adjective  .kaigi-hero { background: #FBBC04; }
.pos-adverb     .kaigi-hero { background: #A78BFA; }
.pos-counter    .kaigi-hero { background: #60A5FA; }
.pos-expression .kaigi-hero { background: #F472B6; }
.pos-auxiliary  .kaigi-hero { background: #F87171; }
.pos-copula     .kaigi-hero { background: #2DD4BF; }
`;

const FRONT_TEMPLATE = `
<div class="card pos-{{POS}}">
  <div class="kaigi-hero"><div class="kaigi-word">{{Word}}</div></div>
  <div class="kaigi-label">Vocabulary <b>Reading</b></div>
  <div class="kaigi-type">{{type:Reading}}</div>
</div>
`.trim();

const BACK_TEMPLATE = `
<div class="card pos-{{POS}}">
  <div class="kaigi-hero"><div class="kaigi-word">{{Word}}</div></div>
  <div class="kaigi-label">Vocabulary <b>Reading</b></div>
  <div class="kaigi-type">{{type:Reading}}</div>
  <div class="kaigi-answer">
    <div class="kaigi-meaning-label">Meaning</div>
    <div class="kaigi-meaning">{{Meaning}}</div>
  </div>
</div>
`.trim();

export const KAIGI_MODEL_DEFINITION = {
  modelName: ANKI_MODEL_NAME,
  inOrderFields: ANKI_FIELDS,
  css: ANKI_CSS,
  isCloze: false,
  cardTemplates: [
    {
      Name: 'Card 1',
      Front: FRONT_TEMPLATE,
      Back: BACK_TEMPLATE,
    },
  ],
};

let ensurePromise = null;

async function ankiRequest(fetchFn, action, params) {
  const resp = await fetchFn({
    action,
    version: 6,
    params: params || {},
  });
  if (!resp?.ok) {
    throw new Error(resp?.error || `AnkiConnect unreachable (status ${resp?.status || 0})`);
  }
  let data;
  try { data = JSON.parse(resp.text); } catch { throw new Error('Invalid response from AnkiConnect'); }
  if (data.error) throw new Error(data.error);
  return data.result;
}

// fetchFn: async (body) => { ok, text, status, error }
export async function ensureAnkiModel(fetchFn) {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const names = await ankiRequest(fetchFn, 'modelNames');
    if (Array.isArray(names) && names.includes(ANKI_MODEL_NAME)) {
      // Keep templates + CSS in sync with the bundled definition.
      try {
        await ankiRequest(fetchFn, 'updateModelTemplates', {
          model: {
            name: ANKI_MODEL_NAME,
            templates: {
              'Card 1': {
                Front: KAIGI_MODEL_DEFINITION.cardTemplates[0].Front,
                Back: KAIGI_MODEL_DEFINITION.cardTemplates[0].Back,
              },
            },
          },
        });
        await ankiRequest(fetchFn, 'updateModelStyling', {
          model: { name: ANKI_MODEL_NAME, css: ANKI_CSS },
        });
      } catch {}
      return;
    }
    await ankiRequest(fetchFn, 'createModel', KAIGI_MODEL_DEFINITION);
  })().catch((err) => {
    ensurePromise = null;
    throw err;
  });
  return ensurePromise;
}
