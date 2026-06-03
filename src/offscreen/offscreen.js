import { toRomaji } from 'wanakana';
import { ensureTokenizer } from './kuromoji-loader.js';
import { lookup as jmdictLookup } from './jmdict.js';
import { translateJaEn, ensureJaEnTranslator, getTranslatorState } from './translator.js';
import { mapPOS } from './pos-map.js';

const KATAKANA_TO_HIRAGANA_OFFSET = 0x3041 - 0x30a1;
function kataToHira(s) {
  if (!s) return '';
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCharCode(code + KATAKANA_TO_HIRAGANA_OFFSET);
    } else {
      out += ch;
    }
  }
  return out;
}

function isPunctOnly(s) {
  return /^[\s\p{P}\p{S}]+$/u.test(s);
}

function hasKanji(s) {
  return /[一-龯㐀-䶿]/.test(s);
}

function enrichToken(t) {
  const surface = t.surface_form;
  if (!surface) return null;
  if (isPunctOnly(surface)) return null;
  try {
    const { type, label } = mapPOS(t);
    const readingKata = t.reading && t.reading !== '*' ? t.reading : '';
    const reading = hasKanji(surface) ? kataToHira(readingKata) : '';
    const romajiSource = readingKata || surface;
    let romaji = '';
    try {
      romaji = toRomaji(romajiSource).toLowerCase();
    } catch {
      romaji = String(romajiSource).toLowerCase();
    }
    return { type, label, reading, romaji, surface, basic: t.basic_form && t.basic_form !== '*' ? t.basic_form : null, readingKata };
  } catch (e) {
    console.warn('[offscreen] token enrich failed', t, e?.message || e);
    return null;
  }
}

async function analyze(text) {
  if (!text || !text.trim()) {
    return { original: text || '', translation: '', words: [] };
  }
  console.log('[offscreen] analyze:', text.slice(0, 40));

  // Kick off sentence translation in parallel. Cap at 5s so a missing
  // Translator model never blocks the breakdown.
  const translationPromise = Promise.race([
    translateJaEn(text),
    new Promise((_, rej) => setTimeout(() => rej(new Error('translator timeout')), 5000)),
  ]).catch((e) => {
    console.warn('[offscreen] translate failed:', e?.message || e);
    return '';
  });

  const tokenizer = await ensureTokenizer();
  let tokens;
  try {
    tokens = tokenizer.tokenize(text);
  } catch (e) {
    console.warn('[offscreen] tokenize threw, falling back:', e?.message || e);
    tokens = [];
  }
  console.log('[offscreen] tokenized:', tokens.length, 'tokens');

  const words = [];
  for (const t of tokens) {
    const enriched = enrichToken(t);
    if (!enriched) continue;
    // kuromoji drops whitespace tokens, so detect whether the original text had
    // whitespace immediately before this token to restore spacing downstream
    // (Latin runs otherwise glue together).
    const start = (t.word_position || 1) - 1;
    const spaceBefore = start > 0 && /\s/.test(text[start - 1]);
    let english = enriched.label;
    if (!english) {
      try {
        english = await jmdictLookup(enriched.basic, enriched.surface, kataToHira(enriched.readingKata), enriched.readingKata);
      } catch (e) {
        console.warn('[offscreen] jmdict lookup failed', enriched.surface, e?.message || e);
        english = '';
      }
    }
    words.push({
      japanese: enriched.surface,
      reading: enriched.reading,
      romaji: enriched.romaji,
      english: english || '',
      type: enriched.type,
      spaceBefore,
    });
  }

  // If kuromoji emitted nothing usable, return a single synthetic word so
  // downstream rendering still paints the line (gray "expression" span) rather
  // than failing back to plain text.
  if (words.length === 0 && text.trim()) {
    words.push({
      japanese: text,
      reading: '',
      romaji: '',
      english: '',
      type: 'expression',
    });
  }

  const translation = await translationPromise;
  return { original: text, translation: translation || '', words };
}

async function translateOnly(text) {
  if (!text || !text.trim()) return '';
  try {
    return await translateJaEn(text);
  } catch (e) {
    console.warn('[offscreen] translate-only failed:', e?.message || e);
    return '';
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'kaigi-nlp') return false;
  (async () => {
    try {
      if (msg.op === 'analyze') {
        const result = await analyze(msg.text);
        sendResponse({ ok: true, result });
      } else if (msg.op === 'translate') {
        const text = await translateOnly(msg.text);
        sendResponse({ ok: true, text });
      } else if (msg.op === 'warmup') {
        await ensureTokenizer();
        // Fire-and-forget so the model download starts now without blocking.
        ensureJaEnTranslator().catch(() => {});
        sendResponse({ ok: true });
      } else if (msg.op === 'translator-state') {
        sendResponse({ ok: true, state: getTranslatorState() });
      } else {
        sendResponse({ ok: false, error: `unknown op: ${msg.op}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

console.log('[kaigi-offscreen] NLP ready');
