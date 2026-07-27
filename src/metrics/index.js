// The instrumentation API. Four functions, all of which take registry values
// only — see events.js for why that shape is the privacy boundary.
//
// Transport: each context (every frame, the popup, each extension page) keeps an
// in-memory spool, pre-aggregates into it, and posts one batch on a timer to the
// service worker, which is the single writer. Writing chrome.storage.local
// directly from here would be wrong: the content bundle runs with all_frames, so
// an iframe-heavy page has N contexts doing read-modify-write on the same key and
// silently losing increments — and the all-sites colorizer makes a 20-frame page
// routine rather than exceptional.

import { H_EDGES, M, S, R, F } from './events.js';
import { bucketIndex, counterKey } from './schema.js';

// Runtime enforcement of the registry. A regex over call sites cannot see
// through a variable or a ternary, so the guarantee that no free-form text can
// become a metric lives here: anything not in the registry is dropped rather
// than recorded.
const VALID_COUNTERS = new Set(Object.values(M));
const VALID_DIMS = new Set([...Object.values(S), ...Object.values(R)]);
const VALID_STEPS = new Set(Object.values(F));

const FLUSH_MS = 60000;        // ordinary counters: batched, jittered below
const FUNNEL_FLUSH_MS = 2000;  // funnel marks are rare and worth landing promptly

let spool = { c: {}, h: {} };
let pendingFunnel = [];
let timer = null;
let flushing = false;

function hasRuntime() {
  return typeof chrome !== 'undefined' && chrome.runtime?.id;
}

function schedule(delay) {
  if (timer) return;
  // Jitter so twenty tabs woken by the same page load do not all post at once.
  const wait = delay + Math.floor(Math.random() * 5000);
  timer = setTimeout(() => { timer = null; flush(); }, wait);
}

/**
 * Post the spool. On any failure the batch is merged back rather than dropped,
 * so a service worker torn down mid-flush costs nothing — the same requeue
 * approach frequency-tracker.js uses for its own writes.
 */
export async function flush() {
  if (flushing) return;
  const batch = spool;
  const funnel = pendingFunnel;
  const empty = Object.keys(batch.c).length === 0
    && Object.keys(batch.h).length === 0
    && funnel.length === 0;
  if (empty || !hasRuntime()) return;

  flushing = true;
  spool = { c: {}, h: {} };
  pendingFunnel = [];
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'kaigi-metric', batch, funnel });
    if (!resp?.ok) throw new Error(resp?.error || 'no response');
  } catch {
    // Merge back and try again on the next tick.
    for (const [k, v] of Object.entries(batch.c)) spool.c[k] = (spool.c[k] || 0) + v;
    for (const [k, arr] of Object.entries(batch.h)) {
      const cur = spool.h[k] || [];
      for (let i = 0; i < arr.length; i++) cur[i] = (cur[i] || 0) + (arr[i] || 0);
      spool.h[k] = cur;
    }
    pendingFunnel = funnel.concat(pendingFunnel);
    schedule(FLUSH_MS);
  } finally {
    flushing = false;
  }
}

/**
 * Increment a counter.
 * @param {string} name a value from M
 * @param {number} [n=1]
 * @param {string} [dim] a value from S or R
 */
export function count(name, n = 1, dim) {
  if (!VALID_COUNTERS.has(name) || !Number.isFinite(n)) return;
  if (dim !== undefined && !VALID_DIMS.has(dim)) return;
  const key = counterKey(name, dim);
  spool.c[key] = (spool.c[key] || 0) + n;
  schedule(FLUSH_MS);
}

/**
 * Record a duration into its histogram.
 * @param {string} name a value from HN
 * @param {number} ms
 */
export function observe(name, ms) {
  const edges = H_EDGES[name];
  if (!edges || !Number.isFinite(ms)) return;
  const arr = spool.h[name] || new Array(edges.length + 1).fill(0);
  arr[bucketIndex(edges, ms)]++;
  spool.h[name] = arr;
  schedule(FLUSH_MS);
}

/**
 * Time an async call into a histogram. Returns whatever the call returns, and
 * re-throws — instrumentation must never change control flow.
 */
export async function time(name, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    observe(name, Date.now() - started);
  }
}

/**
 * Record that a funnel step happened, once ever. Later marks are ignored by the
 * writer, so calling this on every occurrence is fine and expected.
 * @param {string} step a value from F
 */
export function markOnce(step) {
  if (!VALID_STEPS.has(step)) return;
  pendingFunnel.push(step);
  schedule(FUNNEL_FLUSH_MS);
}

// Land whatever is spooled when the page goes away. pagehide fires in cases
// unload does not (bfcache, mobile tab switches).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('pagehide', () => { flush(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
