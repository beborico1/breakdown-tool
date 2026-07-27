import { debugLog } from './debug.js';
import { isOfflineNlpEnabled, analyzeJapaneseWithGemini } from './api.js';
import { inlineBreakdownState } from './state.js';
import { hasJapanese } from '../utils/text.js';
import { showInlineBreakdown } from '../chat/inline-breakdown.js';
import { extractChatMessageText, findChatMessageElement } from '../chat/message-finder.js';
import { renderAutoLiteView } from '../chat/auto-lite-view.js';
import { getRedmineTextBlocks, extractRedmineText } from '../redmine/message-finder.js';
import { renderRedmineAutoLite, assembleRedmineText } from '../redmine/auto-lite-view.js';
import { getGmailMessageBodies } from '../gmail/message-finder.js';
import { renderGmailAutoLite, assembleGmailText } from '../gmail/auto-lite-view.js';

const REDMINE_MAX_LEN = 6000;
const GMAIL_MAX_LEN = 6000;

const processed = new WeakSet();
const pendingText = new WeakMap();
const pendingMode = new WeakMap(); // 'chat-lite' | 'redmine-lite' | 'gmail-lite'
let observer = null;

// An IntersectionObserver holds its targets strongly, and a target is only
// unobserved when it scrolls into view. Messages removed before that (virtual
// scrolling, conversation switches) stayed observed for the life of the tab,
// keeping detached subtrees alive. Track what is observed so disconnected
// targets can be released.
const observed = new Set();

function releaseObserved(el) {
  observer?.unobserve(el);
  observed.delete(el);
}

/**
 * Drop targets that have left the DOM. Also clears their `processed` mark, so a
 * recycled node that comes back gets re-analyzed exactly as it would have
 * before — the observer is simply no longer the thing keeping it alive.
 */
function sweepDetachedTargets() {
  if (observed.size === 0) return;
  for (const el of observed) {
    if (el.isConnected) continue;
    releaseObserved(el);
    processed.delete(el);
    pendingText.delete(el);
    pendingMode.delete(el);
  }
}

function ensureObserver() {
  if (observer) return observer;
  if (typeof IntersectionObserver === 'undefined') return null;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      releaseObserved(el);
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
      } else if (mode === 'gmail-lite') {
        const assembled = assembleGmailText(el);
        if (!assembled || !hasJapanese(assembled)) continue;
        analyzeJapaneseWithGemini(assembled)
          .then((breakdown) => {
            if (!breakdown?.words?.length) return;
            renderGmailAutoLite(el, assembled, breakdown);
          })
          .catch((e) => debugLog('AUTO-ANALYZE', 'gmail lite failed:', e?.message));
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
  observed.add(el);
  obs.observe(el);
}

export async function maybeAutoAnalyzeChat() {
  if (!(await isOfflineNlpEnabled())) return;
  sweepDetachedTargets();
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
  sweepDetachedTargets();
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
 * Paint Gmail message bodies. Without this Gmail only ever colored words the
 * cache already knew, so a cold cache left nothing under the cursor and the
 * hover tooltip appeared broken.
 */
export async function maybeAutoAnalyzeGmail() {
  if (!(await isOfflineNlpEnabled())) return;
  sweepDetachedTargets();
  for (const el of getGmailMessageBodies()) {
    if (processed.has(el)) continue;
    const text = assembleGmailText(el);
    if (!hasJapanese(text)) continue;
    if (text.length > GMAIL_MAX_LEN) continue;
    enqueue(el, text, 'gmail-lite');
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
