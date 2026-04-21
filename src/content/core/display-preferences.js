/**
 * Display preferences for breakdown cards, popovers, and tooltips.
 *
 * A single `chrome.storage.sync` key (`displayPreferences`) toggles which
 * per-word fields (reading/romaji/meaning) and sentence translation are
 * shown across every surface that renders Japanese breakdowns.
 *
 * Implementation is CSS-driven: classes on `<html>` hide matching elements
 * via rules in content.css / transcribe.css / frequency.css. Renderers
 * don't need to know about preferences — they just keep rendering all
 * fields with their existing class names.
 */

export const DEFAULT_DISPLAY_PREFERENCES = {
  showReading: true,
  showRomaji: true,
  showMeaning: true,
  showTranslation: true
};

const STORAGE_KEY = 'displayPreferences';

const CLASS_MAP = {
  showReading: 'kaigi-hide-reading',
  showRomaji: 'kaigi-hide-romaji',
  showMeaning: 'kaigi-hide-meaning',
  showTranslation: 'kaigi-hide-translation'
};

function mergeWithDefaults(stored) {
  return { ...DEFAULT_DISPLAY_PREFERENCES, ...(stored || {}) };
}

export function loadDisplayPreferences() {
  return new Promise(resolve => {
    chrome.storage.sync.get([STORAGE_KEY], result => {
      resolve(mergeWithDefaults(result?.[STORAGE_KEY]));
    });
  });
}

export function applyDisplayPreferencesToDocument(prefs, rootEl = document.documentElement) {
  if (!rootEl) return;
  const merged = mergeWithDefaults(prefs);
  for (const [key, className] of Object.entries(CLASS_MAP)) {
    rootEl.classList.toggle(className, !merged[key]);
  }
}

export function saveDisplayPreferences(partial) {
  return loadDisplayPreferences().then(current => {
    const next = { ...current, ...partial };
    return new Promise(resolve => {
      chrome.storage.sync.set({ [STORAGE_KEY]: next }, () => resolve(next));
    });
  });
}

export function initDisplayPreferences(rootEl = document.documentElement) {
  loadDisplayPreferences().then(prefs => {
    applyDisplayPreferencesToDocument(prefs, rootEl);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    if (!changes[STORAGE_KEY]) return;
    applyDisplayPreferencesToDocument(changes[STORAGE_KEY].newValue, rootEl);
  });
}
