#!/usr/bin/env node
// Tests for the metrics registry and the pure aggregation core. Both are free of
// chrome.* on purpose, so the interesting logic is checkable without a browser.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { M, HN, H_EDGES, F, S, R, LIFETIME_KEYS } from '../src/metrics/events.js';
import {
  bucketIndex, counterKey, dayKey, emptyDay, foldBatch, foldTotals,
  markFunnel, pruneDays, computeKpis,
} from '../src/metrics/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const bad = (n, i) => { console.log(`  ✗ ${n}`); if (i) console.log(`     ${i}`); fail++; };
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e)
  ? ok(n) : bad(n, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const truthy = (n, v, i) => (v ? ok(n) : bad(n, i));

console.log('\nregistry invariants');
{
  const names = Object.values(M);
  eq('counter names are unique', names.length, new Set(names).size);
  truthy('counter names are dotted lowercase',
    names.every(n => /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/.test(n)),
    `offenders: ${names.filter(n => !/^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/.test(n))}`);
  // A histogram whose name has no edges silently drops every sample.
  eq('every histogram name has bucket edges',
    Object.values(HN).sort(), Object.keys(H_EDGES).sort());
  truthy('bucket edges ascend',
    Object.values(H_EDGES).every(e => e.every((v, i) => i === 0 || v > e[i - 1])));
  truthy('lifetime keys are real counters',
    LIFETIME_KEYS.every(k => Object.values(M).includes(k)));
  const dims = [...Object.values(S), ...Object.values(R)];
  eq('dimension values are unique across S and R', dims.length, new Set(dims).size);
}

console.log('\nno free-form arguments reach a metric call');
{
  // The privacy guarantee is that a call site cannot pass arbitrary text. Anything
  // built with a template literal or concatenation would defeat that, so it is a
  // build-time error rather than something a reviewer has to spot.
  const files = [
    'src/content/core/api.js', 'src/content/universal/index.js',
    'src/content/chat/word-tooltip.js', 'src/content/core/frequency-store.js',
    'src/pages/popup/popup.js', 'src/pages/welcome/welcome.js',
  ];
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    // (?<![.\w]) skips io.observe / mo.observe — the DOM observers, not ours.
    for (const m of src.matchAll(/(?<![.\w])(count|observe|markOnce)\s*\(([^)]*)\)/g)) {
      const args = m[2].split(',').map(a => a.trim());
      const first = args[0];
      if (!first) continue;
      if (!/^(M|HN|F)\.[A-Z0-9_]+$/.test(first)) offenders.push(`${f}: ${m[0]}`);
      const dim = args[2];
      // A bare identifier is allowed only when its name says it holds an enum
      // value; count() drops anything unregistered at runtime regardless.
      if (dim && !/^(S|R)\.[A-Z0-9_]+$/.test(dim) && !/Enum$/.test(dim)) {
        offenders.push(`${f}: dim ${m[0]}`);
      }
    }
  }
  eq('every metric argument is a registry member', offenders, []);

  // The runtime guard is the real enforcement, so prove it drops junk.
  const { count: liveCount } = await import('../src/metrics/index.js');
  eq('an unregistered counter name is dropped', liveCount('totally.made.up', 1), undefined);
  eq('a free-text dimension is dropped', liveCount(M.HOVER_SHOWN, 1, 'example.com'), undefined);
}

console.log('\nbucketing');
{
  const edges = [10, 100, 1000];
  eq('below the first edge', bucketIndex(edges, 5), 0);
  eq('between edges', bucketIndex(edges, 50), 1);
  eq('exactly on an edge goes up', bucketIndex(edges, 100), 2);
  eq('above the last edge overflows', bucketIndex(edges, 99999), 3);
  eq('counter key without a dimension', counterKey('a.b'), 'a.b');
  eq('counter key with a dimension', counterKey('a.b', 'meet'), 'a.b@meet');
}

console.log('\nday keys are local, not UTC');
{
  // 2026-03-01T00:30 in JST (UTC+9, offset -540) is still Feb 28 in UTC. The
  // user's "today" is what active-day and return-day counts must follow.
  const jstMidnightish = Date.parse('2026-02-28T15:30:00Z');
  eq('JST evening stays on the local day', dayKey(jstMidnightish, -540), '2026-03-01');
  eq('UTC is unchanged', dayKey(jstMidnightish, 0), '2026-02-28');
}

console.log('\nfolding');
{
  const day = foldBatch(emptyDay(), { c: { 'a@meet': 2, b: 1 }, h: { 'x.ms': [1, 0, 2] } });
  eq('counters accumulate', day.c, { 'a@meet': 2, b: 1 });
  const day2 = foldBatch(day, { c: { 'a@meet': 3 }, h: { 'x.ms': [0, 5] } });
  eq('a second batch adds', day2.c['a@meet'], 5);
  eq('histograms add element-wise and tolerate length', day2.h['x.ms'], [1, 5, 2]);

  const totals = foldTotals({}, { c: { [`${M.COLORIZE_WORDS}@universal`]: 7, [M.PAGE_OPENED]: 3 } });
  eq('lifetime totals strip the dimension', totals[M.COLORIZE_WORDS], 7);
  eq('non-lifetime counters are not accumulated', totals[M.PAGE_OPENED], undefined);
}

console.log('\nfunnel records first occurrence only');
{
  const a = markFunnel({}, F.FIRST_HOVER, 1000);
  eq('first mark lands', a.funnel[F.FIRST_HOVER], 1000);
  eq('and reports the change', a.changed, true);
  const b = markFunnel(a.funnel, F.FIRST_HOVER, 5000);
  eq('a later mark does not move it', b.funnel[F.FIRST_HOVER], 1000);
  eq('and reports no change', b.changed, false);
}

console.log('\npruning the retention window');
{
  const index = ['2025-01-01', '2026-01-01', '2026-03-01', '2026-03-30', '2026-04-01'];
  const { keep, drop } = pruneDays(index, '2026-04-01', 90);
  truthy('a long-past day is dropped', drop.includes('2025-01-01'));
  // Exactly `windowDays` back is retained: the window is inclusive of its edge.
  truthy('the day exactly on the boundary is kept', keep.includes('2026-01-01'));
  truthy('today is kept', keep.includes('2026-04-01'));
  truthy('a day inside the window is kept', keep.includes('2026-03-01'));
  eq('every day is accounted for', keep.length + drop.length, index.length);
  eq('an empty index prunes nothing', pruneDays([], '2026-04-01').drop, []);
}

console.log('\nKPI computation');
{
  const days = {
    '2026-04-01': foldBatch(emptyDay(), {
      c: {
        [`${M.COLORIZE_WORDS}@universal`]: 120,
        [`${M.COLORIZE_WORDS}@meet`]: 30,
        [`${M.COLORIZE_BLOCK_OK}@universal`]: 10,
        [`${M.COLORIZE_BLOCK_FAIL}@universal`]: 2,
        [M.PERM_REQUESTED + '@allhosts']: 1,
        [M.PERM_GRANTED + '@allhosts']: 1,
        [`${M.PAGE_OPENED}@frequency`]: 4,
        [M.HOVER_SHOWN]: 44,
      },
      h: { [HN.NLP_ROUNDTRIP_MS]: [0, 0, 8, 1, 1, 0, 0, 0, 0, 0] },
    }),
  };
  const k = computeKpis({
    meta: { installedAt: 1000, origin: 'install' },
    funnel: { [F.FIRST_COLORIZED_WORD]: 9000 },
    totals: {},
    days,
  });
  eq('time to first coloured word', k.activation.ttfcwMs, 8000);
  eq('activated', k.activation.activated, true);
  eq('grant rate', k.activation.grantRate, 1);
  eq('words summed across surfaces', k.engagement.wordsColored, 150);
  eq('surface mix is preserved', k.engagement.wordsBySurface, { universal: 120, meet: 30 });
  eq('dashboard opens read the dimension', k.retention.dashboardOpens, 4);
  eq('block failure rate', Number(k.health.blockFailureRate.toFixed(4)), 0.1667);
  eq('latency percentile lands in a real bucket', k.latency[HN.NLP_ROUNDTRIP_MS].p50, 250);

  // An upgraded profile would otherwise report a near-zero time-to-value and a
  // permanent 100% activation rate, poisoning the two headline numbers.
  const upgraded = computeKpis({
    meta: { installedAt: 1000, origin: 'update' },
    funnel: { [F.FIRST_COLORIZED_WORD]: 1100 },
    days,
  });
  eq('upgrades are flagged', upgraded.activation.upgraded, true);
  eq('and excluded from time-to-value', upgraded.activation.ttfcwMs, undefined);
  eq('and from the activation rate', upgraded.activation.activated, undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
