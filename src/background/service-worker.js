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
