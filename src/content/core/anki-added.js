// Persistent set of words successfully added to (or queued for) Anki. Used to
// re-apply the `.gcwb-anki-added` underline class on repaints, since Meet's
// minimalistic mode rewrites caption innerHTML and would otherwise wipe it.

const STORAGE_KEY = 'ankiAddedWords';
const CAP = 20000;

const added = new Set();
let loaded = false;
let persistTimer = null;

export async function loadAnkiAddedWords() {
  if (loaded) return;
  try {
    const obj = await chrome.storage.local.get(STORAGE_KEY);
    const arr = obj?.[STORAGE_KEY];
    if (Array.isArray(arr)) {
      for (const w of arr) {
        if (typeof w === 'string' && w) added.add(w);
      }
    }
  } catch {}
  loaded = true;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      let arr = Array.from(added);
      if (arr.length > CAP) arr = arr.slice(arr.length - CAP);
      await chrome.storage.local.set({ [STORAGE_KEY]: arr });
    } catch {}
  }, 500);
}

export function markAnkiAdded(word) {
  if (!word || typeof word !== 'string') return;
  if (added.has(word)) return;
  added.add(word);
  schedulePersist();
}

export function unmarkAnkiAdded(word) {
  if (!word || typeof word !== 'string') return;
  if (!added.has(word)) return;
  added.delete(word);
  schedulePersist();
}

export function isAnkiAdded(word) {
  return !!word && added.has(word);
}
