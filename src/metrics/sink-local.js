// Service-worker side of the metrics pipeline: the single writer.
//
// Everything funnels through one serialized promise chain, because
// chrome.storage get/set is not atomic and concurrent read-modify-write from
// several inbound batches would clobber each other. This is the same
// serialization the token-usage counter used, for the same reason.

import {
  KEY, SCHEMA_VERSION, RETENTION_DAYS, dayKey, emptyDay,
  foldBatch, foldTotals, markFunnel, pruneDays,
} from './schema.js';

/**
 * The worker gets a spool too, on a short debounce. A busy page drives up to 300
 * blocks through the NLP proxy, and ingesting each one directly would mean a full
 * read-modify-write of five keys per block — exactly the write amplification the
 * batching upstream exists to avoid.
 */
const WORKER_FLUSH_MS = 3000;

let writeQueue = Promise.resolve();
let pending = { c: {}, h: {} };
let pendingFunnel = [];
let pendingTimer = null;

function mergeInto(target, batch) {
  for (const [k, v] of Object.entries(batch?.c || {})) {
    target.c[k] = (target.c[k] || 0) + v;
  }
  for (const [k, arr] of Object.entries(batch?.h || {})) {
    const cur = target.h[k] || [];
    for (let i = 0; i < arr.length; i++) cur[i] = (cur[i] || 0) + (arr[i] || 0);
    target.h[k] = cur;
  }
}

/** Queue a batch. Resolves once it is in memory, not once it is on disk. */
export function ingest(batch, funnel) {
  mergeInto(pending, batch);
  if (Array.isArray(funnel) && funnel.length) pendingFunnel.push(...funnel);
  if (!pendingTimer) {
    pendingTimer = setTimeout(() => { pendingTimer = null; commit(); }, WORKER_FLUSH_MS);
  }
}

/** Write everything spooled so far. Safe to call at any time. */
export function commit() {
  const batch = pending;
  const funnel = pendingFunnel;
  pending = { c: {}, h: {} };
  pendingFunnel = [];
  if (!Object.keys(batch.c).length && !Object.keys(batch.h).length && !funnel.length) {
    return writeQueue;
  }
  writeQueue = writeQueue.then(() => applyBatch(batch, funnel)).catch(() => {});
  return writeQueue;
}

async function applyBatch(batch, funnel) {
  const now = Date.now();
  const day = dayKey(now, new Date().getTimezoneOffset());
  const dKey = KEY.day(day);

  const stored = await chrome.storage.local.get([KEY.meta, KEY.funnel, KEY.index, KEY.totals, dKey]);

  const meta = stored[KEY.meta] || {};
  meta.v = SCHEMA_VERSION;
  meta.lastDay = day;
  meta.tzOffset = new Date().getTimezoneOffset();

  const index = Array.isArray(stored[KEY.index]) ? stored[KEY.index] : [];
  if (!index.includes(day)) index.push(day);

  let fun = stored[KEY.funnel] || {};
  for (const step of funnel) {
    fun = markFunnel(fun, step, now).funnel;
  }

  const write = {
    [KEY.meta]: meta,
    [KEY.funnel]: fun,
    [KEY.index]: index,
    [KEY.totals]: foldTotals(stored[KEY.totals], batch),
    [dKey]: foldBatch(stored[dKey] || emptyDay(), batch),
  };
  await chrome.storage.local.set(write);
}

/** Ensure the install id and origin exist. Called once from onInstalled. */
export async function seedMeta({ origin, version }) {
  const stored = await chrome.storage.local.get(KEY.meta);
  const meta = stored[KEY.meta] || {};
  if (meta.installId) return meta;
  const now = Date.now();
  const next = {
    ...meta,
    v: SCHEMA_VERSION,
    // Exists so a future remote sink could deduplicate one install's reports.
    // Nothing transmits it today; see docs/metrics-remote-sink.md.
    installId: crypto.randomUUID(),
    installedAt: now,
    installedVersion: version,
    // 'update' profiles are excluded from activation KPIs: they reach "first
    // coloured word" seconds after an upgrade, which would report a near-zero
    // time-to-value and a permanent 100% activation rate.
    origin,
    tzOffset: new Date().getTimezoneOffset(),
  };
  await chrome.storage.local.set({ [KEY.meta]: next });
  return next;
}

/** Drop day buckets outside the retention window. */
export async function prune() {
  const stored = await chrome.storage.local.get([KEY.index, KEY.meta]);
  const index = Array.isArray(stored[KEY.index]) ? stored[KEY.index] : [];
  if (!index.length) return;
  const today = dayKey(Date.now(), new Date().getTimezoneOffset());
  const { keep, drop } = pruneDays(index, today, RETENTION_DAYS);
  if (!drop.length) return;
  await chrome.storage.local.remove(drop.map(KEY.day));
  await chrome.storage.local.set({ [KEY.index]: keep });
}

/** Everything the Insights page needs, in one read. */
export async function readAll() {
  const head = await chrome.storage.local.get([KEY.meta, KEY.funnel, KEY.index, KEY.totals]);
  const index = Array.isArray(head[KEY.index]) ? head[KEY.index] : [];
  const dayKeys = index.map(KEY.day);
  const dayVals = dayKeys.length ? await chrome.storage.local.get(dayKeys) : {};
  const days = {};
  index.forEach((d) => { days[d] = dayVals[KEY.day(d)] || emptyDay(); });
  return { meta: head[KEY.meta] || {}, funnel: head[KEY.funnel] || {}, totals: head[KEY.totals] || {}, days };
}

/** Delete every metric this extension has stored. */
export async function reset() {
  const stored = await chrome.storage.local.get(KEY.index);
  const index = Array.isArray(stored[KEY.index]) ? stored[KEY.index] : [];
  await chrome.storage.local.remove([
    ...index.map(KEY.day), KEY.meta, KEY.funnel, KEY.index, KEY.totals,
  ]);
}
