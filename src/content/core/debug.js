// Debug infrastructure.
//
// Logging is off by default: `debugLog` runs in content-script hot paths (the
// Meet mutation handler, the chat/gmail highlight passes), and every call site
// evaluates its arguments — template literals, slices, the occasional outerHTML
// dump — before the no-op check can discard them.
//
// It stays runtime-toggleable rather than compiled out, because this extension
// targets obfuscated Google class names that Google rotates; the field logs are
// what reveal a broken selector without shipping a new build.
//
//   chrome.storage.local.set({ kaigiDebug: true })   // enable, live, everywhere
//   chrome.storage.local.set({ kaigiDebug: false })  // disable

const STORAGE_KEY = 'kaigiDebug';

let debugEnabled = false;

/**
 * Whether debug logging is currently on. Guard call sites that build an
 * expensive argument (serialising a DOM subtree, mapping a large array) with
 * this — `debugLog`'s own check cannot save work the caller has already done.
 * @returns {boolean}
 */
export function isDebugEnabled() {
  return debugEnabled;
}

export function debugLog(label, ...args) {
  if (!debugEnabled) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[CaptionTranslator][${ts}] ${label}:`, ...args);
}

// Resolve the flag asynchronously. Anything logged before this settles is
// dropped, which is acceptable: enabling the flag persists, so the next page
// load captures startup too.
try {
  chrome.storage?.local?.get(STORAGE_KEY, (result) => {
    if (chrome.runtime?.lastError) return;
    debugEnabled = result?.[STORAGE_KEY] === true;
  });

  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_KEY]) return;
    debugEnabled = changes[STORAGE_KEY].newValue === true;
  });
} catch {
  // No extension storage in this context (plain-page test harness): stay off.
}
