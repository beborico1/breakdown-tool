import { ingest, commit, seedMeta, prune, readAll, reset } from '../metrics/sink-local.js';
// Fetch proxy: content scripts in MV3 cannot reliably reach a local server from
// strict-CSP pages (chat.google.com, meet.google.com). The service worker has
// extension-origin privileges + host_permissions, so it can fetch any allowed URL.
// Content scripts send {type:'kaigi-fetch', url, init} and get back a serialised
// response with {ok, status, text}.
//
// The origin allowlist is load-bearing, not defence in depth. The content bundle
// is registered on https://*/* once the all-sites colorizer is on, so without it
// this handler is a general-purpose request forwarder running with the
// extension's privileges, reachable from a script injected into every page.
const ALLOWED_FETCH_ORIGINS = new Set([
  'http://localhost:8765',   // AnkiConnect, on the user's own machine
]);

function isAllowedFetchTarget(url) {
  try {
    return ALLOWED_FETCH_ORIGINS.has(new URL(url).origin);
  } catch {
    return false; // unparseable URL
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'kaigi-fetch') return false;
  (async () => {
    if (!isAllowedFetchTarget(msg.url)) {
      sendResponse({ ok: false, status: 0, text: '', error: 'blocked: origin not allowed' });
      return;
    }
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

const METRICS_PRUNE_ALARM = 'kaigi-metrics-prune';

// One dispatching listener. An early return on a name mismatch would make every
// alarm added after the first one silently unreachable.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === OFFSCREEN_IDLE_ALARM) {
    // Land any counters the offscreen work produced before the doc goes away.
    await commit().catch(() => {});
    try {
      if (chrome.offscreen.hasDocument && !(await chrome.offscreen.hasDocument())) return;
      await chrome.offscreen.closeDocument();
    } catch (e) {
      // Already gone, or closed underneath us — nothing to do.
    }
  } else if (alarm.name === METRICS_PRUNE_ALARM) {
    await commit().catch(() => {});
    await prune().catch(e => console.warn('[Metrics] prune failed:', e));
  }
});

// Metrics ingest: the worker is the only writer, so concurrent tabs cannot
// clobber each other's increments.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'kaigi-metric') return false;
  try {
    ingest(msg.batch, msg.funnel);
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false, error: String(e?.message || e) });
  }
  return true;
});

// Insights page reads and reset.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'kaigi-metrics-read' && msg?.type !== 'kaigi-metrics-reset') return false;
  (async () => {
    try {
      if (msg.type === 'kaigi-metrics-reset') {
        await reset();
        sendResponse({ ok: true });
        return;
      }
      await commit();
      sendResponse({ ok: true, data: await readAll() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
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

// Universal (all-sites) colorizer: a single dynamic registration gated behind a
// one-time all-hosts permission grant + the `universalMode` storage flag.
const UNIVERSAL_SCRIPT_ID = 'kaigi-universal';
// Kept in sync with content_scripts[0].matches in manifest.json. These hosts get
// the bundle from the static entry, so excluding them here prevents a second
// injection into the same frame.
const BUILTIN_MATCHES = [
  'https://meet.google.com/*',
  'https://chat.google.com/*',
  'https://mail.google.com/*',
];

function universalScriptConfig() {
  return {
    id: UNIVERSAL_SCRIPT_ID,
    matches: ['https://*/*', 'http://*/*'],
    excludeMatches: BUILTIN_MATCHES,
    js: ['dist/content.js'],
    css: ['src/content/content.css'],
    runAt: 'document_idle',
    allFrames: true,
  };
}

/**
 * Register/unregister the all-sites script on behalf of the popup.
 *
 * The permission request itself must stay in the popup (it needs the user
 * gesture), but the registration config lives here so there is exactly one
 * definition of it. It used to be duplicated in the popup, which meant the two
 * could drift — and a drifted excludeMatches list is invisible until a site
 * mysteriously stops being colorized.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'kaigi-universal-register') return false;
  (async () => {
    try {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [UNIVERSAL_SCRIPT_ID] });
      } catch { /* not registered */ }
      if (msg.enabled) {
        await chrome.scripting.registerContentScripts([universalScriptConfig()]);
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

async function registerUniversalFromStorage() {
  const { universalMode } = await chrome.storage.sync.get('universalMode');
  if (!universalMode) return;
  const has = await chrome.permissions.contains({ origins: ['https://*/*'] });
  if (!has) {
    // Permission revoked while the flag was on — self-heal the flag.
    await chrome.storage.sync.set({ universalMode: false });
    return;
  }
  // Always re-register rather than bailing when the id already exists. A
  // registration persists across updates, so an existing install would otherwise
  // keep running the *old* config forever — and every change to BUILTIN_MATCHES
  // would silently never reach the users who already have it enabled.
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [UNIVERSAL_SCRIPT_ID] });
  } catch (e) {
    // Not registered yet; that is the normal first-run path.
  }
  try {
    await chrome.scripting.registerContentScripts([universalScriptConfig()]);
  } catch (e) {
    console.warn('[Universal] registerContentScripts failed:', e);
  }
}

/**
 * Clean up after features that no longer exist.
 *
 * Custom Sites registered one dynamic content script and held one host permission
 * per user-added origin. Both outlive the update that removed the feature, so
 * without this an upgrading user keeps an orphaned script running on those sites
 * and keeps granting host access they can no longer see or revoke in our UI.
 */
async function migrateFromCustomSites() {
  let customSites;
  try {
    ({ customSites } = await chrome.storage.sync.get('customSites'));
  } catch {
    return;
  }
  if (!Array.isArray(customSites) || customSites.length === 0) return;

  const ids = customSites.map(s => s?.id).filter(Boolean);
  if (ids.length) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids });
    } catch (e) {
      // Some or all were never registered; the permission cleanup still matters.
    }
  }

  const origins = customSites.map(s => s?.origin).filter(Boolean);
  if (origins.length) {
    try {
      await chrome.permissions.remove({ origins });
    } catch (e) {
      console.warn('[Migrate] could not release custom-site permissions:', e);
    }
  }

  await chrome.storage.sync.remove('customSites');
}

/** Storage keys whose readers and writers are both gone. */
const RETIRED_SYNC_KEYS = [
  'geminiApiKey', 'geminiModel', 'geminiLiveModel', 'geminiLiveModelUserSet',
  'transcribeMode', 'useOfflineNlp', 'wordBlockFontSize', 'sentenceChunkSize',
  'minimalisticModeEnabled',
];

async function reconcileDynamicScripts() {
  await migrateFromCustomSites();
  try {
    await chrome.storage.sync.remove(RETIRED_SYNC_KEYS);
    await chrome.storage.local.remove(['tokenUsage', 'tokenUsageSince']);
  } catch (e) {
    // Storage unavailable; retry happens on the next startup.
  }
  await registerUniversalFromStorage();
}

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  reconcileDynamicScripts().catch(e => console.warn('[Init] reconcile failed:', e));

  try {
    chrome.alarms.create(METRICS_PRUNE_ALARM, { periodInMinutes: 360 });
  } catch (e) {
    console.warn('[Metrics] could not schedule prune:', e);
  }
  seedMeta({
    origin: reason === 'install' ? 'install' : 'update',
    version: chrome.runtime.getManifest().version,
  }).catch(() => {});

  // Show the welcome page on a fresh install, and once on the 1.x -> 2.x upgrade:
  // that release removed the API key those users had configured and renamed the
  // product, so landing them on an unchanged toolbar icon would be confusing.
  const fresh = reason === 'install';
  const rebranded = reason === 'update' && String(previousVersion || '').startsWith('1.');
  if (fresh || rebranded) {
    chrome.tabs.create({ url: 'src/pages/welcome/welcome.html' }).catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(() => {
  reconcileDynamicScripts().catch(e => console.warn('[Init] reconcile failed:', e));
});

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


