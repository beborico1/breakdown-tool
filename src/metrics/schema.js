// Pure aggregation, bucketing, pruning and KPI math. Zero references to chrome.*
// so the interesting logic is testable in plain node.

import { H_EDGES, LIFETIME_KEYS, F, M, R } from './events.js';

export const SCHEMA_VERSION = 1;
export const RETENTION_DAYS = 90;

export const KEY = {
  meta: 'metrics:meta',
  funnel: 'metrics:funnel',
  index: 'metrics:days',
  totals: 'metrics:totals',
  day: (d) => `metrics:d:${d}`,
};

/**
 * Local-time day key. Return-day and active-day counts have to match the user's
 * idea of a day, not UTC's, or someone in JST reads their evening session as
 * tomorrow.
 * @param {number} ts epoch ms
 * @param {number} tzOffsetMin Date#getTimezoneOffset() for that moment
 */
export function dayKey(ts, tzOffsetMin) {
  return new Date(ts - tzOffsetMin * 60000).toISOString().slice(0, 10);
}

export function emptyDay() {
  return { c: {}, h: {} };
}

/**
 * Bucket index for a value: 0 for below the first edge, edges.length for the
 * overflow bucket above the last.
 */
export function bucketIndex(edges, value) {
  for (let i = 0; i < edges.length; i++) {
    if (value < edges[i]) return i;
  }
  return edges.length;
}

/** A counter key: the metric name, plus its dimension when it has one. */
export function counterKey(name, dim) {
  return dim ? `${name}@${dim}` : name;
}

/**
 * Fold a batch of pre-aggregated deltas into a day bucket. Length-tolerant on
 * histograms so a bucket-edge change does not corrupt older days.
 * @returns {object} a new day bucket
 */
export function foldBatch(day, batch) {
  const next = { c: { ...(day?.c || {}) }, h: { ...(day?.h || {}) } };
  for (const [k, v] of Object.entries(batch?.c || {})) {
    next.c[k] = (next.c[k] || 0) + v;
  }
  for (const [k, arr] of Object.entries(batch?.h || {})) {
    const cur = next.h[k] || [];
    const merged = new Array(Math.max(cur.length, arr.length)).fill(0);
    for (let i = 0; i < merged.length; i++) {
      merged[i] = (cur[i] || 0) + (arr[i] || 0);
    }
    next.h[k] = merged;
  }
  return next;
}

/** Accumulate the whitelisted lifetime counters. */
export function foldTotals(totals, batch) {
  const next = { ...(totals || {}) };
  const lifetime = new Set(LIFETIME_KEYS);
  for (const [k, v] of Object.entries(batch?.c || {})) {
    const base = k.split('@')[0];
    if (!lifetime.has(base)) continue;
    next[base] = (next[base] || 0) + v;
  }
  return next;
}

/** First write wins: a funnel step records when something first happened. */
export function markFunnel(funnel, step, ts) {
  const cur = funnel || {};
  if (cur[step]) return { funnel: cur, changed: false };
  return { funnel: { ...cur, [step]: ts }, changed: true };
}

/**
 * Which day keys to keep and which to drop.
 * @returns {{keep: string[], drop: string[]}}
 */
export function pruneDays(index, nowDay, windowDays = RETENTION_DAYS) {
  const days = Array.isArray(index) ? [...new Set(index)].sort() : [];
  const cutoff = new Date(`${nowDay}T00:00:00Z`).getTime() - windowDays * 86400000;
  const keep = [];
  const drop = [];
  for (const d of days) {
    const t = new Date(`${d}T00:00:00Z`).getTime();
    (Number.isNaN(t) || t < cutoff ? drop : keep).push(d);
  }
  return { keep, drop };
}

/** Sum a counter across days, optionally across all its dimensions. */
function sumAcross(days, name, { byDim = false } = {}) {
  if (!byDim) {
    let total = 0;
    for (const day of days) {
      for (const [k, v] of Object.entries(day.c || {})) {
        if (k === name || k.startsWith(`${name}@`)) total += v;
      }
    }
    return total;
  }
  const out = {};
  for (const day of days) {
    for (const [k, v] of Object.entries(day.c || {})) {
      if (!k.startsWith(`${name}@`)) continue;
      const dim = k.slice(name.length + 1);
      out[dim] = (out[dim] || 0) + v;
    }
  }
  return out;
}

/** Approximate a percentile from bucket counts, reported as the bucket's edge. */
function percentileFromBuckets(counts, edges, p) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = total * p;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i];
    if (seen >= target) return i < edges.length ? edges[i] : edges[edges.length - 1];
  }
  return edges[edges.length - 1];
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Turn the stored shape into the numbers a person actually wants to read.
 *
 * Profiles that arrived by update are excluded from activation figures: they
 * would hit "first coloured word" seconds after the update with an install
 * timestamp minted at the same moment, reporting a near-zero time-to-value and
 * a 100% activation rate forever.
 */
export function computeKpis({ meta = {}, funnel = {}, totals = {}, days = {} } = {}) {
  const dayList = Object.keys(days).sort();
  const buckets = dayList.map(d => days[d] || emptyDay());
  const upgraded = meta.origin === 'update';

  const activation = { upgraded };
  if (!upgraded && meta.installedAt) {
    activation.activated = !!funnel[F.FIRST_COLORIZED_WORD];
    activation.ttfcwMs = funnel[F.FIRST_COLORIZED_WORD]
      ? funnel[F.FIRST_COLORIZED_WORD] - meta.installedAt
      : null;
  }
  activation.grantRate = rate(
    sumAcross(buckets, M.PERM_GRANTED),
    sumAcross(buckets, M.PERM_REQUESTED)
  );

  const wordsBySurface = sumAcross(buckets, M.COLORIZE_WORDS, { byDim: true });
  const blocksOk = sumAcross(buckets, M.COLORIZE_BLOCK_OK);
  const blocksFail = sumAcross(buckets, M.COLORIZE_BLOCK_FAIL);

  const engagement = {
    activeDays: dayList.length,
    firstDay: dayList[0] || null,
    lastDay: dayList[dayList.length - 1] || null,
    sessions: sumAcross(buckets, M.SESSION_START),
    wordsColored: sumAcross(buckets, M.COLORIZE_WORDS),
    wordsBySurface,
    hovers: sumAcross(buckets, M.HOVER_SHOWN),
    breakdowns: sumAcross(buckets, M.BREAKDOWN_OPENED),
  };

  const retention = {
    newWords: sumAcross(buckets, M.VOCAB_NEW_WORDS),
    wordsCounted: sumAcross(buckets, M.VOCAB_COUNTED),
    ankiCards: sumAcross(buckets, M.ANKI_CARD_ADDED),
    dashboardOpens: sumAcross(buckets, M.PAGE_OPENED, { byDim: true })[R.FREQUENCY] || 0,
  };

  const health = {
    blockFailureRate: rate(blocksFail, blocksOk + blocksFail),
    strandedBlocks: sumAcross(buckets, M.COLORIZE_BLOCK_STRANDED),
    analyzeFailures: sumAcross(buckets, M.ANALYZE_FAIL),
    dictFailures: sumAcross(buckets, M.DICT_FAIL, { byDim: true }),
    translatorState: sumAcross(buckets, M.TRANSLATOR_STATE, { byDim: true }),
    offscreenCreateFails: sumAcross(buckets, M.OFFSCREEN_CREATE_FAIL),
  };

  const latency = {};
  for (const [name, edges] of Object.entries(H_EDGES)) {
    const merged = [];
    for (const day of buckets) {
      const arr = day.h?.[name];
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) merged[i] = (merged[i] || 0) + arr[i];
    }
    if (!merged.length) continue;
    latency[name] = {
      count: merged.reduce((a, b) => a + (b || 0), 0),
      p50: percentileFromBuckets(merged.map(n => n || 0), edges, 0.5),
      p95: percentileFromBuckets(merged.map(n => n || 0), edges, 0.95),
    };
  }

  const funnelSteps = Object.values(F).map(step => ({ step, at: funnel[step] || null }));

  return { meta, activation, engagement, retention, health, latency, funnelSteps, totals, dayList };
}
