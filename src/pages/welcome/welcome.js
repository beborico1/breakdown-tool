import { analyzeJapaneseTokens, warmupNlp } from '../../content/core/api.js';
import { paintBlockTokens } from '../../content/shared/auto-lite-core.js';
import { setupWordTooltip, onIslandChange } from '../../content/chat/word-tooltip.js';
import { setupWordIsland } from '../../content/shared/word-island.js';
import { translateClause, warmClauseTranslator, peekClauseTranslation } from '../../content/core/clause-translate.js';
import { initDisplayPreferences } from '../../content/core/display-preferences.js';
import { count, markOnce } from '../../metrics/index.js';
import { M, F, R } from '../../metrics/events.js';

const ORIGINS = ['https://*/*', 'http://*/*'];

const sampleEl = document.getElementById('sample');
const sampleHint = document.getElementById('sampleHint');
const legendEl = document.getElementById('legend');
const enableBtn = document.getElementById('enableBtn');
const enableHint = document.getElementById('enableHint');

/** Mirrors the .gcwb-type-* rules in content.css. */
const LEGEND = [
  ['noun', 'Noun'],
  ['verb', 'Verb'],
  ['particle', 'Particle'],
  ['adjective', 'Adjective'],
  ['adverb', 'Adverb'],
  ['counter', 'Counter'],
  ['expression', 'Expression'],
  ['auxiliary', 'Auxiliary'],
];

function renderLegend() {
  for (const [type, label] of LEGEND) {
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    // Same class the painter uses, so the chip takes its colour from the same
    // rule the page words do and the two cannot drift apart.
    swatch.className = `gcwb-type-${type} legend-swatch`;
    swatch.textContent = '■';
    const name = document.createElement('span');
    name.textContent = label;
    li.append(swatch, name);
    legendEl.appendChild(li);
  }
}

/**
 * Paint the sample through the real pipeline. This doubles as the dictionary
 * warmup: the first analysis after an install pays for loading kuromoji and
 * JMdict, and it is better to pay it here, behind a visible "getting ready"
 * line, than on the first real page the user opens.
 */
async function paintSample() {
  const text = sampleEl.textContent;
  try {
    const res = await analyzeJapaneseTokens(text);
    if (!res?.words?.length) throw new Error('no words');
    paintBlockTokens(sampleEl, text, res.words, {
      marker: 'gcwbUniv',
      boundaryDots: true,
      marks: 'ja',
      decorateNativeRuby: true,
    });
    sampleHint.textContent = 'Hover any word above.';
  } catch (e) {
    sampleHint.textContent =
      'The dictionary could not load just now. Coloring will still work on real pages — reload this page to retry.';
  }
}

async function refreshEnableState() {
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: ORIGINS });
  } catch { /* treat as not granted */ }
  const { universalMode } = await chrome.storage.sync.get('universalMode');
  const on = granted && universalMode === true;
  enableBtn.disabled = on;
  enableBtn.textContent = on ? 'Coloring is on' : 'Turn on coloring';
  if (on) {
    enableHint.textContent =
      'You can pause it on any individual site from the toolbar popup, or switch it off entirely at any time.';
  }
}

enableBtn.addEventListener('click', async () => {
  count(M.PERM_REQUESTED, 1, R.ALLHOSTS);
  const granted = await chrome.permissions.request({ origins: ORIGINS });
  if (!granted) {
    count(M.PERM_DENIED, 1, R.ALLHOSTS);
    enableHint.textContent =
      'Not enabled. Chrome needs all-sites access to find Japanese on the pages you visit — you can turn it on later from the toolbar popup.';
    return;
  }
  const reg = await chrome.runtime.sendMessage({ type: 'kaigi-universal-register', enabled: true });
  if (!reg?.ok) {
    enableHint.textContent = 'Could not enable: ' + (reg?.error || 'unknown error');
    return;
  }
  count(M.PERM_GRANTED, 1, R.ALLHOSTS);
  count(M.SETTING_UNIVERSAL_ON);
  markOnce(F.ALL_SITES_GRANTED);
  await chrome.storage.sync.set({ universalMode: true });
  enableHint.textContent = 'On. Open any Japanese page — tabs already open need a reload.';
  await refreshEnableState();
});

initDisplayPreferences();
count(M.PAGE_OPENED, 1, R.WELCOME);
markOnce(F.WELCOME_SEEN);
renderLegend();
setupWordTooltip({ translateClause, warmClauseTranslator, peekClauseTranslation });
// The sample above is painted with the real spans, and the section below it
// tells the reader to click two of them together. Without this it is inert,
// and the first thing they try does nothing.
setupWordIsland({ onChange: onIslandChange });
warmupNlp();
paintSample();
refreshEnableState();
