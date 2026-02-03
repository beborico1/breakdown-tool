// Debug infrastructure
export const DEBUG = true;

export function debugLog(label, ...args) {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[CaptionTranslator][${ts}] ${label}:`, ...args);
}
