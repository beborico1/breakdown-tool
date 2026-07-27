import { computeKpis } from '../../metrics/schema.js';
import { F } from '../../metrics/events.js';

const el = (id) => document.getElementById(id);

const FUNNEL_LABELS = {
  [F.INSTALLED]: 'Installed',
  [F.WELCOME_SEEN]: 'Saw the welcome page',
  [F.FIRST_ANALYZE_ATTEMPT]: 'First analysis attempted',
  [F.FIRST_COLORIZED_WORD]: 'First word colored',
  [F.ALL_SITES_GRANTED]: 'Granted all-sites access',
  [F.FIRST_HOVER]: 'First hover',
  [F.FIRST_WORD_SAVED]: 'First word saved',
  [F.FIRST_ANKI_CARD]: 'First Anki card',
};

function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}

function fmtPct(v) {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleString() : null;
}

function renderStats(container, rows) {
  container.replaceChildren();
  for (const [label, value, muted] of rows) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (muted) dd.className = 'muted';
    wrap.append(dt, dd);
    container.appendChild(wrap);
  }
}

function renderBars(container, obj) {
  container.replaceChildren();
  const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    container.textContent = 'Nothing colored yet.';
    return;
  }
  const max = entries[0][1] || 1;
  for (const [name, value] of entries) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('span');
    label.textContent = name;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(2, (value / max) * 100)}%`;
    track.appendChild(fill);
    const val = document.createElement('span');
    val.className = 'bar-val';
    val.textContent = fmtNum(value);
    row.append(label, track, val);
    container.appendChild(row);
  }
}

let raw = null;

function render(data) {
  raw = data;
  const k = computeKpis(data);
  const hasAny = k.engagement.activeDays > 0;
  el('empty').hidden = hasAny;
  el('body').hidden = !hasAny;
  if (!hasAny) return;

  renderStats(el('activation'), [
    ['Installed', fmtDate(k.meta.installedAt) || '—', true],
    ['Version at install', k.meta.installedVersion || '—', true],
    ['Time to first colored word',
      k.activation.upgraded ? 'n/a (upgrade)' : fmtDuration(k.activation.ttfcwMs)],
    ['All-sites access granted', fmtPct(k.activation.grantRate)],
  ]);

  const funnel = el('funnel');
  funnel.replaceChildren();
  for (const { step, at } of k.funnelSteps) {
    const li = document.createElement('li');
    li.textContent = at ? `${FUNNEL_LABELS[step] || step} — ${fmtDate(at)}` : (FUNNEL_LABELS[step] || step);
    if (!at) li.className = 'pending';
    funnel.appendChild(li);
  }

  renderStats(el('engagement'), [
    ['Active days', fmtNum(k.engagement.activeDays)],
    ['Words colored', fmtNum(k.engagement.wordsColored)],
    ['Hovers', fmtNum(k.engagement.hovers)],
    ['Breakdowns opened', fmtNum(k.engagement.breakdowns)],
  ]);
  renderBars(el('surfaces'), k.engagement.wordsBySurface);

  renderStats(el('retention'), [
    ['New words', fmtNum(k.retention.newWords)],
    ['Word sightings', fmtNum(k.retention.wordsCounted)],
    ['Anki cards added', fmtNum(k.retention.ankiCards)],
    ['Dashboard opens', fmtNum(k.retention.dashboardOpens)],
  ]);

  const latency = k.latency['nlp.roundtrip.ms'];
  renderStats(el('health'), [
    ['Block failure rate', fmtPct(k.health.blockFailureRate)],
    ['Stranded blocks', fmtNum(k.health.strandedBlocks)],
    ['Analysis failures', fmtNum(k.health.analyzeFailures)],
    ['Analysis time (median)', latency ? `${latency.p50} ms` : '—'],
  ]);

  // The raw table exists so nothing is hidden: whatever is stored is on screen.
  const rawBody = el('raw');
  rawBody.replaceChildren();
  const merged = {};
  for (const day of Object.values(data.days || {})) {
    for (const [key, v] of Object.entries(day.c || {})) merged[key] = (merged[key] || 0) + v;
  }
  for (const [key, v] of Object.entries(merged).sort()) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = key;
    const val = document.createElement('td');
    val.textContent = fmtNum(v);
    tr.append(name, val);
    rawBody.appendChild(tr);
  }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

el('exportJson').addEventListener('click', () => {
  download('japanese-in-color-insights.json', JSON.stringify(raw, null, 2), 'application/json');
});

el('exportCsv').addEventListener('click', () => {
  const rows = [['day', 'metric', 'value']];
  for (const [day, bucket] of Object.entries(raw?.days || {})) {
    for (const [key, v] of Object.entries(bucket.c || {})) rows.push([day, key, v]);
  }
  download('japanese-in-color-insights.csv', rows.map(r => r.join(',')).join('\n'), 'text/csv');
});

el('reset').addEventListener('click', async () => {
  if (!confirm('Delete every metric stored on this computer? This cannot be undone.')) return;
  await chrome.runtime.sendMessage({ type: 'kaigi-metrics-reset' });
  location.reload();
});

async function load() {
  const resp = await chrome.runtime.sendMessage({ type: 'kaigi-metrics-read' });
  if (!resp?.ok) {
    el('empty').hidden = false;
    el('empty').textContent = 'Could not read the stored metrics.';
    return;
  }
  render(resp.data);
}

load();
