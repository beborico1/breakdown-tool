import { ensureKaigiModel, KAIGI_MODEL_NAME, KAIGI_FIELDS } from '../chat/anki-model.js';

const ANKI_ORIGIN = 'http://localhost:8765/*';
const ANKI_URL = 'http://localhost:8765';
const DEFAULT_DECK = 'kaigi';
const DEFAULT_MODEL = KAIGI_MODEL_NAME;

const KAIGI_POS_VALUES = new Set([
  'noun', 'verb', 'particle', 'adjective', 'adverb',
  'counter', 'expression', 'auxiliary', 'copula',
]);

async function ankiFetch(body) {
  return chrome.runtime.sendMessage({
    type: 'kaigi-fetch',
    url: ANKI_URL,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  });
}

async function getAnkiSettings() {
  try {
    const { ankiSettings } = await chrome.storage.sync.get('ankiSettings');
    return {
      deckName: ankiSettings?.deckName || DEFAULT_DECK,
      modelName: ankiSettings?.modelName || DEFAULT_MODEL,
      frontField: ankiSettings?.frontFieldName || 'Front',
      backField: ankiSettings?.backFieldName || 'Back',
    };
  } catch {
    return { deckName: DEFAULT_DECK, modelName: DEFAULT_MODEL, frontField: 'Front', backField: 'Back' };
  }
}

async function checkPermission() {
  try {
    if (location.protocol === 'chrome-extension:' && chrome.permissions?.contains) {
      return await chrome.permissions.contains({ origins: [ANKI_ORIGIN] });
    }
    const resp = await chrome.runtime.sendMessage({
      type: 'kaigi-perm-contains',
      origins: [ANKI_ORIGIN],
    });
    return !!resp?.granted;
  } catch {
    return false;
  }
}

export async function addOneCard({ word, reading, english, pos }) {
  if (!(await checkPermission())) {
    throw new Error('Anki permission not granted. Open the extension popup → AnkiConnect Setup to grant access to localhost:8765.');
  }

  const settings = await getAnkiSettings();
  const meaning = english && english !== '-' ? english : '';
  const safePos = KAIGI_POS_VALUES.has(pos) ? pos : '';

  let fields;
  if (settings.modelName === KAIGI_MODEL_NAME) {
    await ensureKaigiModel(ankiFetch);
    fields = {
      [KAIGI_FIELDS[0]]: word,
      [KAIGI_FIELDS[1]]: reading && reading !== word ? reading : '',
      [KAIGI_FIELDS[2]]: meaning,
      [KAIGI_FIELDS[3]]: safePos,
    };
  } else {
    const front = reading && reading !== word ? `${word}（${reading}）` : word;
    fields = { [settings.frontField]: front, [settings.backField]: meaning };
  }

  const tags = ['google-meet-caption-copier', 'live-transcription'];
  if (safePos) tags.push(`pos-${safePos}`);

  const note = {
    deckName: settings.deckName,
    modelName: settings.modelName,
    fields,
    tags,
    options: { allowDuplicate: false, duplicateScope: 'deck' },
  };

  const body = {
    action: 'multi',
    version: 6,
    params: {
      actions: [
        { action: 'createDeck', version: 6, params: { deck: settings.deckName } },
        { action: 'addNote', version: 6, params: { note } },
      ],
    },
  };

  const resp = await ankiFetch(body);
  if (!resp?.ok) {
    throw new Error(resp?.error || `AnkiConnect unreachable (status ${resp?.status || 0}). Is Anki running?`);
  }
  let data;
  try { data = JSON.parse(resp.text); } catch { throw new Error('Invalid response from AnkiConnect'); }
  if (data.error) throw new Error(data.error);
  const results = Array.isArray(data.result) ? data.result : [];
  const addNoteResult = results[1];
  if (addNoteResult && typeof addNoteResult === 'object' && addNoteResult.error) {
    throw new Error(addNoteResult.error);
  }
  return { result: addNoteResult, deck: settings.deckName, model: settings.modelName };
}

export function isRetriableAnkiError(msg) {
  const s = String(msg || '').toLowerCase();
  if (s.includes('duplicate')) return false;
  if (s.includes('cannot create note')) return false;
  return true;
}
