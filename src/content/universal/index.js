import { debugLog } from '../core/debug.js';
import { hasJapanese, splitJapaneseText } from '../utils/text.js';
import { isOfflineNlpEnabled, analyzeJapaneseTokensOnly } from '../core/api.js';
import { isGoogleChat } from '../chat/message-finder.js';
import { isGmail } from '../gmail/message-finder.js';
import { isRedmine } from '../redmine/message-finder.js';
import { findJapaneseBlocks, SKIP_SUBTREE_TAGS } from '../shared/block-walker.js';
import { collectBlockTextNodes, paintBlockTokens } from '../shared/auto-lite-core.js';
import { createAnalyzeQueue } from '../shared/analyze-queue.js';
import { setupWordTooltip } from '../chat/word-tooltip.js';

/**
 * Universal (all-sites) Japanese colorizer.
 *
 * On any page that isn't one of the specialized built-in surfaces, finds every
 * block containing Japanese text, colorizes each word by part-of-speech in place
 * (reusing the shared auto-lite core + offline NLP pipeline), and reuses the
 * existing hover breakdown card. Analysis is lazy (viewport-gated), concurrency
 * limited, and resilient to dynamic/SPA pages.
 */

const UNIVERSAL_MARKER = 'gcwbUniv';          // dataset key → data-gcwb-univ
const UNIVERSAL_MAX_LEN = 2000;               // per-block analyze cap (chunked beyond)
const UNIVERSAL_MAX_BLOCKS = 300;             // per-scan block cap
const RESCAN_DEBOUNCE_MS = 150;
const URL_POLL_MS = 1500;
const IO_ROOT_MARGIN = '200px';               // analyze blocks just before they enter view

const processed = new WeakSet();               // blocks already observed/handled
const retried = new WeakSet();                 // blocks given one post-drift retry
const analyzeQueue = createAnalyzeQueue({ concurrency: 3 });

let io = null;
let mo = null;
let rescanTimer = null;
let suppressDepth = 0;                          // >0 while we mutate the DOM ourselves
let started = false;

/** This extension's own injected nodes — never treat them as page content. */
function isOwnElement(n) {
  if (!n || n.nodeType !== Node.ELEMENT_NODE) return false;
  const cl = n.classList;
  return !!cl && (
    cl.contains('gcwb-word-tooltip') ||
    cl.contains('gcwb-word-popover') ||
    cl.contains('gcwb-auto-translate-toggle') ||
    cl.contains('gcwb-auto-translate-panel')
  );
}

/** Wrap a DOM-mutating function so its own mutation records are ignored. */
function paintGuarded(fn) {
  suppressDepth++;
  try {
    fn();
  } finally {
    // Decrement after the MutationObserver microtask for this paint has run.
    queueMicrotask(() => { suppressDepth--; });
  }
}

/** Run only in the main frame or a same-origin subframe (skip cross-origin ads). */
function isAllowedFrame() {
  try {
    if (window.top === window.self) return true;
    return window.top.location.origin === window.location.origin;
  } catch {
    return false; // cross-origin access throws → cross-origin frame → skip
  }
}

function isBuiltInSurface() {
  return (
    window.location.hostname === 'meet.google.com' ||
    isGoogleChat() ||
    isGmail() ||
    isRedmine()
  );
}

/**
 * Enqueue a block for viewport-gated analysis. No painted-descendant veto
 * here: with nested units, a painted child block must not starve its parent's
 * own text, and analyzeAndPaint self-guards (re-collection excludes painted
 * spans, so an already-painted unit assembles to nothing Japanese).
 */
function enqueueBlock(block) {
  if (!block || processed.has(block)) return;
  if (block.dataset[UNIVERSAL_MARKER] === '1') return;
  if (!io) return;
  processed.add(block);
  io.observe(block);
}

/** Analyze a block's assembled text and paint per-word coloring in place. */
async function analyzeAndPaint(block) {
  if (!block.isConnected) return;
  if (block.dataset[UNIVERSAL_MARKER] === '1') return;

  // Assemble with the same exclusions the walker used so offsets line up.
  // Nested blocks are their own units, so stop at them here and in the paint.
  const { assembled } = collectBlockTextNodes(block, SKIP_SUBTREE_TAGS, { stopAtNestedBlocks: true });
  if (!assembled || !hasJapanese(assembled)) return;

  const chunks = assembled.length > UNIVERSAL_MAX_LEN
    ? splitJapaneseText(assembled, UNIVERSAL_MAX_LEN)
    : [assembled];
  if (chunks.length > 1) {
    debugLog('UNIVERSAL', `chunked block (${assembled.length} chars → ${chunks.length} parts)`);
  }

  let words = [];
  try {
    for (const chunk of chunks) {
      const res = await analyzeQueue.enqueue(() => analyzeJapaneseTokensOnly(chunk));
      if (res?.words?.length) words = words.concat(res.words);
    }
  } catch (e) {
    debugLog('UNIVERSAL', 'analyze failed:', e?.message);
    return;
  }
  if (!words.length) return;
  if (block.dataset[UNIVERSAL_MARKER] === '1') return; // painted while we waited

  let painted = false;
  paintGuarded(() => {
    painted = paintBlockTokens(block, assembled, words, {
      marker: UNIVERSAL_MARKER,
      excludeTags: SKIP_SUBTREE_TAGS,
      stopAtNestedBlocks: true,
    });
  });

  // If the DOM drifted between assemble and paint, paintBlockTokens marks but
  // doesn't wrap. Give the block one retry so transient drift still colorizes.
  if (!painted && !retried.has(block)) {
    retried.add(block);
    delete block.dataset[UNIVERSAL_MARKER];
    processed.delete(block);
    setTimeout(() => enqueueBlock(block), RESCAN_DEBOUNCE_MS);
  }
}

/** Scan the document for Japanese blocks and enqueue any new ones. */
function scan() {
  if (!document.body) return;
  const blocks = findJapaneseBlocks(document.body, { maxBlocks: UNIVERSAL_MAX_BLOCKS });
  for (const block of blocks) enqueueBlock(block);
}

function scheduleRescan() {
  if (rescanTimer) return;
  rescanTimer = setTimeout(() => { rescanTimer = null; scan(); }, RESCAN_DEBOUNCE_MS);
}

/** ChildList mutation that only added our own tooltip/popover/panel UI. */
function isOwnUiMutation(m) {
  if (m.type !== 'childList' || m.addedNodes.length === 0) return false;
  for (const n of m.addedNodes) if (!isOwnElement(n)) return false;
  return true;
}

/**
 * When the page mutates inside an already-painted block (e.g. a recycled
 * virtualized row gets new text), clear its marker so the rescan repaints it.
 */
function clearMarkedAncestor(target) {
  const el = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  const marked = el?.closest?.(`[data-gcwb-univ="1"]`);
  if (marked) {
    delete marked.dataset[UNIVERSAL_MARKER];
    processed.delete(marked);
  }
}

function onMutations(records) {
  if (suppressDepth > 0) return; // our own paint — ignore
  let relevant = false;
  for (const m of records) {
    if (isOwnUiMutation(m)) continue;
    clearMarkedAncestor(m.target);
    relevant = true;
  }
  if (relevant) scheduleRescan();
}

function onSoftNav() {
  // SPA route change: the DOM may have been swapped. Rescan once it settles.
  setTimeout(scan, RESCAN_DEBOUNCE_MS);
}

function setupObservers() {
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const block = entry.target;
        io.unobserve(block);
        analyzeAndPaint(block);
      }
    }, { rootMargin: IO_ROOT_MARGIN });
  }

  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(onMutations);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.addEventListener('popstate', onSoftNav);
  window.addEventListener('hashchange', onSoftNav);

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; onSoftNav(); }
  }, URL_POLL_MS);
}

function start() {
  if (started) return;
  started = true;
  setupWordTooltip();   // self-guards against double-binding
  setupObservers();
  scan();
  // Block detection reads computed display; stylesheets still loading can
  // misclassify styled spans as inline, so rescan once everything is loaded.
  // A block already painted with pre-stylesheet boundaries stays as painted
  // until a mutation inside it clears the marker — accepted: healing it here
  // would need per-block seam signatures for a rare slow-CSS static page.
  if (document.readyState !== 'complete') {
    window.addEventListener('load', () => scan(), { once: true });
  }
}

/**
 * Initialize the universal colorizer. No-op on built-in surfaces, cross-origin
 * subframes, when the toggle is off, or when the offline NLP pipeline is off.
 */
export async function initializeUniversal() {
  if (isBuiltInSurface() || !isAllowedFrame()) return;

  let universalMode = false;
  try {
    const r = await chrome.storage.sync.get('universalMode');
    universalMode = r?.universalMode === true;
  } catch {
    return;
  }
  if (!universalMode) return;

  try {
    if (!(await isOfflineNlpEnabled())) {
      debugLog('UNIVERSAL', 'offline NLP disabled; universal colorizing needs it');
      return;
    }
  } catch {
    return;
  }

  debugLog('UNIVERSAL', 'initializing universal colorizer');
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
