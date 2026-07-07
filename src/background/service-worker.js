// Fetch proxy: content scripts in MV3 cannot reliably reach a local server from
// strict-CSP pages (chat.google.com, meet.google.com). The service worker has
// extension-origin privileges + host_permissions, so it can fetch any allowed URL.
// Content scripts send {type:'kaigi-fetch', url, init} and get back a serialised
// response with {ok, status, text}.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'kaigi-fetch') return false;
  (async () => {
    try {
      const r = await fetch(msg.url, msg.init || {});
      const text = await r.text();
      sendResponse({ ok: r.ok, status: r.status, text });
    } catch (err) {
      sendResponse({ ok: false, status: 0, text: '', error: String(err) });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'kaigi-perm-contains') return false;
  (async () => {
    try {
      const has = await chrome.permissions.contains({ origins: msg.origins || [] });
      sendResponse({ ok: true, granted: !!has });
    } catch (err) {
      sendResponse({ ok: false, granted: false, error: String(err) });
    }
  })();
  return true;
});

// Offscreen document management for offline NLP (kuromoji + JMdict + Translator API).
// Only one offscreen doc may exist per extension. Created lazily on first NLP request.
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
// Do NOT memoize success: a created offscreen doc can be reaped by the browser
// (e.g. memory pressure late in a long meeting) while this worker stays alive.
// Re-check existence on every request and recreate a destroyed doc; the transient
// promise only dedupes concurrent createDocument calls.
let offscreenCreating = null;

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['DOM_PARSER'],
        justification: 'Run kuromoji tokenizer and Chrome Translator API for offline Japanese NLP.',
      });
    } catch (e) {
      // A concurrent caller may have created it first — that race is benign.
      if (!String(e).includes('single offscreen')) throw e;
    }
  })();
  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'kaigi-nlp-proxy') return false;
  (async () => {
    try {
      await ensureOffscreen();
      const response = await chrome.runtime.sendMessage({
        type: 'kaigi-nlp',
        op: msg.op,
        text: msg.text,
      });
      sendResponse(response);
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-to-japanese' && command !== 'translate-to-japanese-replace') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isChatPage = tab?.url?.includes('chat.google.com') ||
    (tab?.url?.includes('mail.google.com') && tab?.url?.includes('#chat'));
  if (!isChatPage) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { action: command });
  } catch (e) {
    // Content script not loaded; nothing to do
  }
});

async function registerCustomSitesFromStorage() {
  const { customSites = [] } = await chrome.storage.sync.get('customSites');
  if (customSites.length === 0) return;

  const existing = await chrome.scripting.getRegisteredContentScripts();
  const existingIds = new Set(existing.map(s => s.id));

  const toRegister = [];
  for (const site of customSites) {
    if (existingIds.has(site.id)) continue;
    const has = await chrome.permissions.contains({ origins: [site.origin] });
    if (!has) continue;
    toRegister.push({
      id: site.id,
      matches: [site.origin],
      js: ['dist/content.js'],
      css: ['src/content/content.css'],
      runAt: 'document_end',
      allFrames: true
    });
  }

  if (toRegister.length > 0) {
    try {
      await chrome.scripting.registerContentScripts(toRegister);
    } catch (e) {
      console.warn('[CustomSites] registerContentScripts failed:', e);
    }
  }
}

chrome.runtime.onInstalled.addListener(registerCustomSitesFromStorage);
chrome.runtime.onStartup.addListener(registerCustomSitesFromStorage);

chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  if (origins.length === 0) return;
  const { customSites = [] } = await chrome.storage.sync.get('customSites');
  const matching = customSites.filter(s => origins.includes(s.origin));
  if (matching.length === 0) return;

  const ids = matching.map(s => s.id);
  try {
    await chrome.scripting.unregisterContentScripts({ ids });
  } catch (e) {
    console.warn('[CustomSites] unregisterContentScripts failed:', e);
  }

  const remaining = customSites.filter(s => !origins.includes(s.origin));
  await chrome.storage.sync.set({ customSites: remaining });
});
