import { debugLog } from './debug.js';
import { isOfflineNlpEnabled, analyzeJapaneseWithGemini } from './api.js';
import { inlineBreakdownState } from './state.js';
import { hasJapanese } from '../utils/text.js';
import { showInlineBreakdown } from '../chat/inline-breakdown.js';
import { extractChatMessageText, findChatMessageElement } from '../chat/message-finder.js';
import { renderAutoLiteView } from '../chat/auto-lite-view.js';
import { getRedmineTextBlocks, extractRedmineText } from '../redmine/message-finder.js';
import { renderRedmineAutoLite, assembleRedmineText } from '../redmine/auto-lite-view.js';

const REDMINE_MAX_LEN = 6000;

const processed = new WeakSet();
const pendingText = new WeakMap();
const pendingMode = new WeakMap(); // 'chat-lite' | 'redmine-lite'
let observer = null;

function ensureObserver() {
  if (observer) return observer;
  if (typeof IntersectionObserver === 'undefined') return null;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      observer.unobserve(el);
      const text = pendingText.get(el);
      const mode = pendingMode.get(el);
      pendingText.delete(el);
      pendingMode.delete(el);
      if (!text) continue;
      // Re-check breakdown state — message may have been opened manually in the meantime.
      if (inlineBreakdownState.get(el)?.isShowingBreakdown) continue;
      if (mode === 'chat-lite') {
        const bubbleEl = el.closest('.nF6pT');
        analyzeJapaneseWithGemini(text)
          .then((breakdown) => {
            if (!breakdown?.words?.length) return;
            if (inlineBreakdownState.get(el)?.isShowingBreakdown) return;
            renderAutoLiteView(el, breakdown, bubbleEl);
          })
          .catch((e) => debugLog('AUTO-ANALYZE', 'lite analyze failed:', e?.message));
      } else if (mode === 'redmine-lite') {
        // Re-assemble at analyze-time to match what the renderer will see.
        const assembled = assembleRedmineText(el);
        if (!assembled || !hasJapanese(assembled)) continue;
        analyzeJapaneseWithGemini(assembled)
          .then((breakdown) => {
            if (!breakdown?.words?.length) return;
            renderRedmineAutoLite(el, assembled, breakdown);
          })
          .catch((e) => debugLog('AUTO-ANALYZE', 'redmine lite failed:', e?.message));
      } else {
        try {
          showInlineBreakdown(el, text);
        } catch (e) {
          debugLog('AUTO-ANALYZE', 'showInlineBreakdown threw:', e?.message);
        }
      }
    }
  }, { rootMargin: '100px' });
  return observer;
}

function enqueue(el, text, mode) {
  if (processed.has(el)) return;
  if (inlineBreakdownState.get(el)?.isShowingBreakdown) return;
  const obs = ensureObserver();
  if (!obs) return;
  processed.add(el);
  pendingText.set(el, text);
  pendingMode.set(el, mode);
  obs.observe(el);
}

export async function maybeAutoAnalyzeChat() {
  if (!(await isOfflineNlpEnabled())) return;
  const els = document.querySelectorAll('.Zc1Emd');
  for (const el of els) {
    if (processed.has(el)) continue;
    const text = extractChatMessageText(el);
    if (!hasJapanese(text)) continue;
    enqueue(el, text, 'chat-lite');
  }
}

export async function maybeAutoAnalyzeRedmine() {
  if (!(await isOfflineNlpEnabled())) return;
  const blocks = getRedmineTextBlocks();
  for (const el of blocks) {
    if (processed.has(el)) continue;
    const text = extractRedmineText(el);
    if (!hasJapanese(text)) continue;
    if (text.length > REDMINE_MAX_LEN) continue;
    enqueue(el, text, 'redmine-lite');
  }
}

/**
 * Listen for the offline NLP toggle so flipping it ON in an already-open tab
 * starts auto-analysis without requiring a reload.
 */
export function watchOfflineToggle(onEnable) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (!changes.useOfflineNlp) return;
      const newVal = changes.useOfflineNlp.newValue;
      if (newVal !== false) onEnable();
    });
  } catch (e) {
    debugLog('AUTO-ANALYZE', 'storage.onChanged unavailable:', e?.message);
  }
}
