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

async function analyze(text) {
  if (!text || !text.trim()) {
    return { original: text || '', translation: '', words: [] };
  }
  console.log('[offscreen] analyze:', text.slice(0, 40));
  const tokenizer = await ensureTokenizer();
  const tokens = tokenizer.tokenize(text);
  console.log('[offscreen] tokenized:', tokens.length, 'tokens');

  // Kick off sentence translation in parallel with per-word enrichment.
  // Cap at 8s so a missing Translator model never blocks the breakdown.
  const translationPromise = Promise.race([
    translateJaEn(text),
    new Promise((_, rej) => setTimeout(() => rej(new Error('translator timeout')), 8000)),
  ]).catch((e) => {
    console.warn('[offscreen] translate failed:', e?.message || e);
    return '';
  });

  const words = [];
  for (const t of tokens) {
    const surface = t.surface_form;
    if (!surface || isPunctOnly(surface)) continue;
    const { type, label } = mapPOS(t);
    const readingKata = t.reading && t.reading !== '*' ? t.reading : '';
    const reading = hasKanji(surface) ? kataToHira(readingKata) : '';
    const romajiSource = readingKata || surface;
    const romaji = toRomaji(romajiSource).toLowerCase();
    let english = label;
    if (!english) {
      const basic = t.basic_form && t.basic_form !== '*' ? t.basic_form : null;
      english = await jmdictLookup(basic, surface, kataToHira(readingKata), readingKata);
    }
    words.push({
      japanese: surface,
      reading,
      romaji,
      english: english || '',
      type,
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
