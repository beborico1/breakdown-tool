import { initDisplayPreferences } from '../../content/core/display-preferences.js';
import { count, markOnce, flush } from '../../metrics/index.js';
import { M, F, R } from '../../metrics/events.js';

const ORIGINS = ['https://*/*', 'http://*/*'];

const statusEl = document.getElementById('status');
const toggle = document.getElementById('universalModeToggle');
const heroSub = document.getElementById('heroSub');
const heroAsk = document.getElementById('heroAsk');
const heroStatus = document.getElementById('heroStatus');
const heroDot = document.getElementById('heroDot');
const heroStatusText = document.getElementById('heroStatusText');
const siteToggleBtn = document.getElementById('siteToggleBtn');
const reloadTabBtn = document.getElementById('reloadTabBtn');
const meetCard = document.getElementById('meetCard');

const SUB_ON = 'Hover any colored word to see how it is read and what it means.';
const SUB_OFF = 'Every Japanese word gets a color for its job in the sentence. Hover a word to see how it is read and what it means.';

/** Pages Chrome will not let any extension touch. */
const RESTRICTED = [
  'chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://',
  'https://chrome.google.com/webstore', 'https://chromewebstore.google.com',
];

let activeTab = null;

function showStatus(message, isSuccess) {
  statusEl.textContent = message;
  statusEl.className = `status ${isSuccess ? 'success' : 'error'}`;
  statusEl.style.display = 'block';
}

function clearStatus() {
  statusEl.style.display = 'none';
}

function isRestricted(url) {
  return !url || RESTRICTED.some(p => url.startsWith(p));
}

/** Ask the content script in a tab what it is doing. Null when it is not there. */
function askTab(tabId, op) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'kaigi-universal-control', op }, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp || null);
      });
    } catch { resolve(null); }
  });
}

async function getPausedSites() {
  const { pausedSites } = await chrome.storage.sync.get('pausedSites');
  return Array.isArray(pausedSites) ? pausedSites : [];
}

function setDot(kind) {
  heroDot.className = `status-dot is-${kind}`;
}

function hostOf(origin) {
  try { return new URL(origin).host; } catch { return origin; }
}

/**
 * Resolve one of several states and render it.
 *
 * Being explicit here is the point: the popup used to say nothing at all, so a
 * user whose tab predated the grant had no way to tell "not working" from "no
 * Japanese on this page". The built-in-surface state matters just as much —
 * without it Meet, Chat, Gmail and Redmine all report "this tab was open before
 * you turned it on" while the extension is working perfectly.
 */
async function renderHero() {
  const on = toggle.checked;
  heroSub.textContent = on ? SUB_ON : SUB_OFF;
  heroAsk.hidden = on;
  heroStatus.hidden = !on;
  siteToggleBtn.hidden = true;
  reloadTabBtn.hidden = true;
  if (!on) return;

  if (isRestricted(activeTab?.url)) {
    setDot('idle');
    heroStatusText.textContent = 'Chrome does not let extensions run on this page.';
    return;
  }

  const info = await askTab(activeTab.id, 'status');

  if (!info) {
    setDot('warn');
    heroStatusText.textContent = 'This tab was open before you turned it on.';
    reloadTabBtn.hidden = false;
    return;
  }

  if (info.builtIn) {
    const label = { meet: 'Google Meet', chat: 'Google Chat', gmail: 'Gmail', redmine: 'Redmine' }[info.surface];
    setDot('on');
    heroStatusText.textContent = `Coloring ${label} on this page.`;
    return;
  }

  const paused = (await getPausedSites()).includes(info.origin);
  siteToggleBtn.hidden = false;
  siteToggleBtn.textContent = paused ? 'Resume on this site' : 'Pause on this site';

  if (paused) {
    setDot('warn');
    heroStatusText.textContent = `Paused on ${hostOf(info.origin)}`;
  } else if (info.painted > 0) {
    setDot('on');
    heroStatusText.textContent =
      `Coloring this page — ${info.painted} Japanese ${info.painted === 1 ? 'word' : 'words'}.`;
  } else {
    setDot('idle');
    heroStatusText.textContent = 'No Japanese found on this page yet.';
  }
}

/** Message every tab, tolerating the many that have no content script. */
async function broadcast(msg) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(t => (
    t.id == null ? Promise.resolve() : chrome.tabs.sendMessage(t.id, msg).catch(() => {})
  )));
}

toggle.addEventListener('change', async () => {
  clearStatus();
  if (toggle.checked) {
    // Must run synchronously from this gesture, so no confirmation dialog can
    // come first — the explanation lives in the resting copy above instead.
    count(M.PERM_REQUESTED, 1, R.ALLHOSTS);
    const granted = await chrome.permissions.request({ origins: ORIGINS });
    if (!granted) {
      count(M.PERM_DENIED, 1, R.ALLHOSTS);
      toggle.checked = false;
      await renderHero();
      showStatus('Not enabled. Chrome needs all-sites access to find Japanese on the pages you visit.', false);
      return;
    }
    const reg = await chrome.runtime.sendMessage({ type: 'kaigi-universal-register', enabled: true });
    if (!reg?.ok) {
      toggle.checked = false;
      await chrome.permissions.remove({ origins: ORIGINS }).catch(() => {});
      await renderHero();
      showStatus('Could not enable: ' + (reg?.error || 'unknown error'), false);
      return;
    }
    count(M.PERM_GRANTED, 1, R.ALLHOSTS);
    count(M.SETTING_UNIVERSAL_ON);
    markOnce(F.ALL_SITES_GRANTED);
    await chrome.storage.sync.set({ universalMode: true });
    // Colour the page the user is already looking at, rather than telling them
    // to go and reload their tabs and hoping that they do.
    if (!isRestricted(activeTab?.url)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id, allFrames: true },
          files: ['dist/content.js'],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: activeTab.id, allFrames: true },
          files: ['src/content/content.css'],
        });
      } catch { /* restricted page, or already injected */ }
    }
    await renderHero();
    showStatus('On. Other tabs that are already open need a reload.', true);
  } else {
    // Order matters: revoke before broadcasting. A rejected sendMessage must
    // never be able to strand the all-hosts grant while the switch reads off.
    count(M.SETTING_UNIVERSAL_OFF);
    await chrome.storage.sync.set({ universalMode: false });
    await chrome.runtime.sendMessage({ type: 'kaigi-universal-register', enabled: false }).catch(() => {});
    await chrome.permissions.remove({ origins: ORIGINS }).catch(() => {});
    await broadcast({ type: 'kaigi-universal-control', op: 'pause' });
    await renderHero();
    showStatus('Off. Chrome no longer has all-sites access.', true);
  }
});

siteToggleBtn.addEventListener('click', async () => {
  const info = await askTab(activeTab.id, 'status');
  if (!info) return;
  const paused = await getPausedSites();
  const isPaused = paused.includes(info.origin);
  const next = isPaused
    ? paused.filter(o => o !== info.origin)
    : [...paused, info.origin].slice(-200);   // sync has a per-item quota, so bound it
  if (isPaused) count(M.SITE_RESUMED);
  else count(M.SITE_PAUSED);
  await chrome.storage.sync.set({ pausedSites: next });
  await askTab(activeTab.id, isPaused ? 'resume' : 'pause');
  await renderHero();
});

reloadTabBtn.addEventListener('click', async () => {
  await chrome.tabs.reload(activeTab.id);
  window.close();
});

/** Meet-only actions. The card holding them is hidden everywhere else. */
function sendAction(action) {
  chrome.tabs.sendMessage(activeTab.id, { action }, async (response) => {
    if (chrome.runtime.lastError) {
      showStatus('Refresh the Meet page and try again', false);
      return;
    }
    if (!response) return;
    if (response.success && response.text) {
      try {
        await navigator.clipboard.writeText(response.text);
        showStatus(response.message, true);
      } catch {
        showStatus('Could not copy to the clipboard', false);
      }
    } else {
      showStatus(response.message, response.success);
    }
  });
}

document.getElementById('copyAll').addEventListener('click', () => sendAction('copyAll'));
document.getElementById('copyNew').addEventListener('click', () => sendAction('copyNew'));
document.getElementById('downloadTranscript').addEventListener('click', () => sendAction('downloadTranscript'));

document.getElementById('viewAllWords').addEventListener('click', () => {
  chrome.tabs.create({ url: 'src/pages/frequency/frequency.html' });
});
document.getElementById('liveTranscribe').addEventListener('click', () => {
  chrome.tabs.create({ url: 'src/pages/transcribe/transcribe.html' });
});
document.getElementById('openWelcome').addEventListener('click', () => {
  chrome.tabs.create({ url: 'src/pages/welcome/welcome.html' });
});
document.getElementById('openInsights').addEventListener('click', () => {
  chrome.tabs.create({ url: 'src/pages/insights/insights.html' });
});

async function init() {
  initDisplayPreferences();
  count(M.PAGE_OPENED, 1, R.POPUP);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;

  const { universalMode } = await chrome.storage.sync.get('universalMode');
  toggle.checked = universalMode === true;

  meetCard.hidden = !activeTab?.url?.includes('meet.google.com');

  await renderHero();
}

window.addEventListener('blur', () => { flush(); });

init();
