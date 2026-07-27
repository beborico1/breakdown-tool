import { debugLog } from '../core/debug.js';
import { hasJapanese, splitJapaneseText } from '../utils/text.js';
import { analyzeJapaneseTokens } from '../core/api.js';
import { isGoogleChat } from '../chat/message-finder.js';
import { isGmail } from '../gmail/message-finder.js';
import { isRedmine } from '../redmine/message-finder.js';
import { findJapaneseBlocks, nearestBlockRoot, SKIP_SUBTREE_TAGS } from '../shared/block-walker.js';
import { collectBlockTextNodes, paintBlockTokens } from '../shared/auto-lite-core.js';
import { createAnalyzeQueue } from '../shared/analyze-queue.js';
import { setupWordTooltip } from '../chat/word-tooltip.js';
import { translateClause, warmClauseTranslator } from '../core/clause-translate.js';
import { count, markOnce } from '../../metrics/index.js';
import { M, F, S } from '../../metrics/events.js';

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
// Separate retry budgets. These are different failures with different causes —
// a cold-start analyze timeout and a DOM edit landing mid-paint — and sharing one
// budget stranded any block that hit both: whichever came first spent the retry,
// and the second left the block permanently uncoloured with no marker for a
// rescan to clear.
const analyzeRetried = new WeakSet();          // blocks given one post-failure retry
const paintRetried = new WeakSet();            // blocks given one post-drift retry
// The IntersectionObserver holds observed blocks strongly and only releases
// them when they scroll into view. On an infinite-scroll or virtualized page,
// blocks recycled away before ever intersecting would be retained (with their
// detached subtrees) for the life of the page. Tracked so scan() can drop them.
const observedBlocks = new Set();
const analyzeQueue = createAnalyzeQueue({ concurrency: 3 });

let io = null;
let mo = null;
let rescanTimer = null;
let urlPollTimer = null;
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
  observedBlocks.add(block);
  io.observe(block);
}

/**
 * Release blocks that have left the DOM. Their `processed` mark goes too, so a
 * recycled node returning to the page is enqueued again exactly as before.
 */
function sweepDetachedBlocks() {
  if (observedBlocks.size === 0) return;
  for (const block of observedBlocks) {
    if (block.isConnected) continue;
    io?.unobserve(block);
    observedBlocks.delete(block);
    processed.delete(block);
  }
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
      const res = await analyzeQueue.enqueue(() => analyzeJapaneseTokens(chunk));
      if (res?.words?.length) words = words.concat(res.words);
    }
  } catch (e) {
    debugLog('UNIVERSAL', 'analyze failed:', e?.message);
    // Leaving the block in `processed` would strand it: it carries no marker for
    // clearMarkedAncestor to clear, so no later rescan would ever revisit it.
    // The offscreen document closes when idle, so the first analyze after a quiet
    // spell failing is routine rather than exceptional.
    count(M.COLORIZE_BLOCK_FAIL, 1, S.UNIVERSAL);
    if (!analyzeRetried.has(block)) {
      analyzeRetried.add(block);
      processed.delete(block);
      setTimeout(() => enqueueBlock(block), RESCAN_DEBOUNCE_MS);
    } else {
      // Out of retries and carrying no marker, so nothing will revisit it. This
      // is the actionable signal: a raw failure count is mostly benign cold-start
      // retries, but a stranded block is text the user never gets.
      count(M.COLORIZE_BLOCK_STRANDED, 1, S.UNIVERSAL);
    }
    return;
  }
  if (!words.length) return;
  if (block.dataset[UNIVERSAL_MARKER] === '1') return; // painted while we waited

  let painted = false;
  paintGuarded(() => {
    painted = paintBlockTokens(block, assembled, words, {
      marker: UNIVERSAL_MARKER,
      excludeTags: SKIP_SUBTREE_TAGS,
      // No block translation: dots carry their clause and resolve it on hover,
      // so paint stays a tokenize-only round trip.
      boundaryDots: true,
      marks: 'ja',
      stopAtNestedBlocks: true,
      decorateNativeRuby: true,
    });
  });

  if (painted) {
    // Counted here rather than at entry: paintBlockTokens returns false on
    // assembled-text drift, and counting before checking would inflate the
    // headline engagement numbers with blocks that were never coloured, then
    // double-count them on the retry pass.
    count(M.COLORIZE_BLOCK_OK, 1, S.UNIVERSAL);
    count(M.COLORIZE_WORDS, words.length, S.UNIVERSAL);
    markOnce(F.FIRST_COLORIZED_WORD);
  } else {
    count(M.PAINT_DRIFT, 1, S.UNIVERSAL);
  }

  // If the DOM drifted between assemble and paint, paintBlockTokens marks but
  // doesn't wrap. Give the block one retry so transient drift still colorizes.
  if (!painted && !paintRetried.has(block)) {
    paintRetried.add(block);
    delete block.dataset[UNIVERSAL_MARKER];
    processed.delete(block);
    setTimeout(() => enqueueBlock(block), RESCAN_DEBOUNCE_MS);
  }
}

/**
 * Find Japanese blocks and enqueue any new ones.
 *
 * @param {Element[]|null} [roots] - restrict the walk to these subtrees. A
 *   whole-document walk visits every text node and resolves computed styles, so
 *   doing it 150 ms after every page mutation was a permanent background cost
 *   on any site that animates or polls. Pass null for the initial pass and
 *   after SPA navigation, where the whole document really is new.
 */
function scan(roots = null) {
  if (!document.body) return;
  sweepDetachedBlocks();

  const styleCache = new Map();
  let scanRoots;

  if (!roots || roots.length === 0) {
    scanRoots = [document.body];
  } else {
    scanRoots = [];
    for (const el of roots) {
      if (el.isConnected) scanRoots.push(nearestBlockRoot(el, styleCache));
    }
    // Drop any root already covered by another, so nested mutations in the
    // same container are walked once.
    scanRoots = scanRoots.filter((r, i) =>
      !scanRoots.some((other, j) => j !== i && other !== r && other.contains(r)));
  }

  const walked = new Set();
  for (const root of scanRoots) {
    if (walked.has(root)) continue;
    walked.add(root);
    const blocks = findJapaneseBlocks(root, { maxBlocks: UNIVERSAL_MAX_BLOCKS });
    for (const block of blocks) enqueueBlock(block);
  }
}

// Mutation targets awaiting a scoped rescan. Past MAX_SCOPED_ROOTS distinct
// roots a single document walk is cheaper than many subtree walks, so the batch
// degrades to a full scan rather than growing without bound.
const pendingRoots = new Set();
const MAX_SCOPED_ROOTS = 20;
let fullRescanQueued = false;

function scheduleRescan() {
  if (rescanTimer) return;
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    const roots = fullRescanQueued ? null : [...pendingRoots];
    pendingRoots.clear();
    fullRescanQueued = false;
    scan(roots);
  }, RESCAN_DEBOUNCE_MS);
}

/**
 * ChildList mutation that only added or removed our own tooltip/popover/panel
 * UI. Removals matter as much as additions: tearing down a tooltip appends a
 * childList record to document.body carrying only removedNodes, and treating
 * that as page activity queues document.body as a rescan root, which makes the
 * scoped walk degrade to a full-document walk on every hover.
 */
function isOwnUiMutation(m) {
  if (m.type !== 'childList') return false;
  if (m.addedNodes.length === 0 && m.removedNodes.length === 0) return false;
  for (const n of m.addedNodes) if (!isOwnElement(n)) return false;
  for (const n of m.removedNodes) if (!isOwnElement(n)) return false;
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

    if (fullRescanQueued) continue;
    const el = m.target?.nodeType === Node.ELEMENT_NODE ? m.target : m.target?.parentElement;
    if (!el) continue;
    if (pendingRoots.size >= MAX_SCOPED_ROOTS) {
      fullRescanQueued = true;
      pendingRoots.clear();
      continue;
    }
    pendingRoots.add(el);
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
        observedBlocks.delete(block);
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

  // Compare pathname, not href: sites that write scroll position or filter
  // state into the query string or hash via replaceState would otherwise
  // trigger a full document rescan every poll.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; onSoftNav(); }
  }, URL_POLL_MS);
}

function start() {
  if (started) return;
  started = true;
  setupWordTooltip({ translateClause, warmClauseTranslator });   // self-guards against double-binding
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

/** Which built-in surface this page is, for the popup's status line. */
function surfaceName() {
  if (window.location.hostname === 'meet.google.com') return 'meet';
  if (isGoogleChat()) return 'chat';
  if (isGmail()) return 'gmail';
  if (isRedmine()) return 'redmine';
  return 'universal';
}

/** Coloured words currently painted in this frame. */
function paintedWordCount() {
  return document.querySelectorAll('.gcwb-auto-word').length;
}

/**
 * Tear down so the page can be left as we found it. Every guard that says
 * "already handled" has to be reset here, or a later resume finds every block
 * still in `processed` and paints nothing.
 */
function stopUniversal() {
  if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null; }
  if (urlPollTimer) { clearInterval(urlPollTimer); urlPollTimer = null; }
  if (io) { io.disconnect(); io = null; }
  if (mo) { mo.disconnect(); mo = null; }
  window.removeEventListener('popstate', onSoftNav);
  window.removeEventListener('hashchange', onSoftNav);
  for (const block of observedBlocks) processed.delete(block);
  observedBlocks.clear();
  started = false;
}

/**
 * Answer the popup. Installed before the built-in-surface check on purpose: on
 * Meet/Chat/Gmail/Redmine the universal colorizer does not run, but the popup
 * still needs to know the page is handled — otherwise it reports "this tab was
 * open before you turned it on" while the extension is working perfectly.
 */
function installControlListener() {
  if (window.__kaigiControlBound) return;
  window.__kaigiControlBound = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'kaigi-universal-control') return false;
    const surface = surfaceName();
    if (msg.op === 'status') {
      sendResponse({
        ok: true,
        surface,
        builtIn: surface !== 'universal',
        running: started,
        painted: paintedWordCount(),
        origin: location.origin,
      });
    } else if (msg.op === 'pause') {
      stopUniversal();
      sendResponse({ ok: true });
    } else if (msg.op === 'resume') {
      start();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'unknown op' });
    }
    return true;
  });
}

/**
 * Initialize the universal colorizer. No-op on built-in surfaces, cross-origin
 * subframes, when neither the toggle nor a one-page trial is on, or when the
 * user has paused this origin.
 */
export async function initializeUniversal() {
  if (!isAllowedFrame()) return;
  installControlListener();
  if (isBuiltInSurface()) return;

  // A one-page trial injected from the popup via activeTab. Chrome requires an
  // explicit grant before the colorizer can run everywhere, so this lets the
  // user see what it does on the page in front of them first. It lasts only
  // until this page navigates.
  const trial = window.__kaigiUniversalTrial === true;

  let universalMode = false;
  let pausedSites = [];
  try {
    const r = await chrome.storage.sync.get(['universalMode', 'pausedSites']);
    universalMode = r?.universalMode === true;
    pausedSites = Array.isArray(r?.pausedSites) ? r.pausedSites : [];
  } catch {
    if (!trial) return;
  }
  if (!universalMode && !trial) return;
  // A trial is an explicit "show me on this page", so it overrides a pause.
  if (!trial && pausedSites.includes(location.origin)) {
    debugLog('UNIVERSAL', 'paused on this site');
    return;
  }

  debugLog('UNIVERSAL', 'initializing universal colorizer');
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
