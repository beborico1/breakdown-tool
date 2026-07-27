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

// The offscreen document is a full renderer pinning every dictionary it has
// loaded: ~96 MB of kuromoji ArrayBuffers, kuromoji's expanded target_map, and
// the parsed JMdict map — on the order of 220 MB, held for the whole browser
// session once a single word has been analyzed. Close it after a stretch with
// no NLP traffic; the next request recreates it (ensureOffscreen already
// re-checks existence rather than memoizing success).
//
// This must be a chrome.alarms alarm, not setTimeout: MV3 tears the worker
// down after ~30 s idle, which is well before any useful timeout would fire.
const OFFSCREEN_IDLE_ALARM = 'kaigi-offscreen-idle';
const OFFSCREEN_IDLE_MINUTES = 15;

function scheduleOffscreenIdleClose() {
  // create() replaces an existing alarm of the same name, so each NLP request
  // pushes the deadline out — the document only closes after a genuine lull.
  try {
    chrome.alarms.create(OFFSCREEN_IDLE_ALARM, { delayInMinutes: OFFSCREEN_IDLE_MINUTES });
  } catch (e) {
    console.warn('[Offscreen] could not schedule idle close:', e);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== OFFSCREEN_IDLE_ALARM) return;
  try {
    if (chrome.offscreen.hasDocument && !(await chrome.offscreen.hasDocument())) return;
    await chrome.offscreen.closeDocument();
  } catch (e) {
    // Already gone, or closed underneath us — nothing to do.
  }
});

async function ensureOffscreen() {
  scheduleOffscreenIdleClose();
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

// Universal (all-sites) colorizer: a single dynamic registration gated behind a
// one-time all-hosts permission grant + the `universalMode` storage flag.
const UNIVERSAL_SCRIPT_ID = 'kaigi-universal';
const BUILTIN_MATCHES = [
  'https://meet.google.com/*',
  'https://chat.google.com/*',
  'https://mail.google.com/*',
  'https://redmine.irvine.jp/*',
];

function universalScriptConfig() {
  return {
    id: UNIVERSAL_SCRIPT_ID,
    matches: ['https://*/*', 'http://*/*'],
    // The 4 built-ins are injected via the static manifest entry; excluding them
    // here prevents a double injection into the same frame.
    excludeMatches: BUILTIN_MATCHES,
    js: ['dist/content.js'],
    css: ['src/content/content.css'],
    runAt: 'document_idle',
    allFrames: true,
  };
}

async function registerUniversalFromStorage() {
  const { universalMode } = await chrome.storage.sync.get('universalMode');
  if (!universalMode) return;
  const has = await chrome.permissions.contains({ origins: ['https://*/*'] });
  if (!has) {
    // Permission revoked while the flag was on — self-heal the flag.
    await chrome.storage.sync.set({ universalMode: false });
    return;
  }
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.some(s => s.id === UNIVERSAL_SCRIPT_ID)) return;
  try {
    await chrome.scripting.registerContentScripts([universalScriptConfig()]);
  } catch (e) {
    console.warn('[Universal] registerContentScripts failed:', e);
  }
}

async function reconcileDynamicScripts() {
  await registerCustomSitesFromStorage();
  await registerUniversalFromStorage();
}

chrome.runtime.onInstalled.addListener(reconcileDynamicScripts);
chrome.runtime.onStartup.addListener(reconcileDynamicScripts);

// If the all-hosts permission is revoked, tear down universal mode.
chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  if (!origins.some(o => o === 'https://*/*' || o === 'http://*/*')) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [UNIVERSAL_SCRIPT_ID] });
  } catch (e) {
    // Not registered; nothing to do.
  }
  await chrome.storage.sync.set({ universalMode: false });
});

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
