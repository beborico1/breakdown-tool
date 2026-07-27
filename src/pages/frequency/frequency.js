import { initDisplayPreferences } from '../../content/core/display-preferences.js';
import { flushAnkiQueue } from '../../content/core/anki-queue.js';
import { addOneCard, isRetriableAnkiError } from '../../content/core/anki-card.js';
import { readAllFrequency, addMissingWords } from '../../content/core/frequency-store.js';

initDisplayPreferences();

async function flushPendingFromFrequency() {
  try {
    const { flushed } = await flushAnkiQueue(async (card) => {
      try {
        await addOneCard(card);
        return { ok: true, retriable: false };
      } catch (err) {
        const msg = err?.message || String(err);
        return { ok: false, retriable: isRetriableAnkiError(msg) };
      }
    });
    if (flushed > 0) {
      console.log('[Anki] Flushed', flushed, 'queued card(s) from Frequency page');
    }
  } catch (err) {
    console.warn('[Anki] Flush from Frequency failed:', err);
  }
}

// DOM Elements
const totalWordsEl = document.getElementById('totalWordsValue');
const uniqueWordsEl = document.getElementById('uniqueWordsValue');
const daysTrackingEl = document.getElementById('daysTrackingValue');
const ankiSelectedValueEl = document.getElementById('ankiSelectedValue');
const typeChartEl = document.getElementById('typeChart');
const wordGridEl = document.getElementById('wordGrid');
const emptyStateEl = document.getElementById('emptyState');
const loadingStateEl = document.getElementById('loadingState');
const searchInput = document.getElementById('searchInput');
const sortBySelect = document.getElementById('sortBy');
const pageSizeSelect = document.getElementById('pageSize');
const paginationEl = document.getElementById('pagination');
const exportJsonBtn = document.getElementById('exportJson');
const exportCsvBtn = document.getElementById('exportCsv');

// Anki DOM Elements
const ankiStatusEl = document.getElementById('ankiStatus');
const syncToAnkiBtn = document.getElementById('syncToAnki');
const selectAllBtn = document.getElementById('selectAll');
const deselectAllBtn = document.getElementById('deselectAll');

// Modal shell
const ankiSettingsModal = document.getElementById('ankiSettingsModal');
const ankiModalCount = document.getElementById('ankiModalCount');
const ankiModalClose = document.getElementById('ankiModalClose');

// Destination
const ankiConnStatusRow = document.getElementById('ankiConnStatusRow');
const ankiDeckSelect = document.getElementById('ankiDeckSelect');
const ankiModelSelect = document.getElementById('ankiModelSelect');
const ankiFrontFieldSelect = document.getElementById('ankiFrontFieldSelect');
const ankiBackFieldSelect = document.getElementById('ankiBackFieldSelect');
const ankiFieldWarning = document.getElementById('ankiFieldWarning');

// Reading + back + tags
const ankiIncludeFuriganaInput = document.getElementById('ankiIncludeFurigana');
const ankiFuriganaFormatSelect = document.getElementById('ankiFuriganaFormat');
const ankiIncludePartOfSpeechInput = document.getElementById('ankiIncludePartOfSpeech');
const ankiIncludeRomajiInput = document.getElementById('ankiIncludeRomaji');
const ankiIncludeCountInput = document.getElementById('ankiIncludeCount');
const ankiCustomTagsInput = document.getElementById('ankiCustomTags');
const ankiAutoTagByTypeInput = document.getElementById('ankiAutoTagByType');

// Advanced
const ankiTestConnectionBtn = document.getElementById('ankiTestConnection');
const ankiResetDefaultsBtn = document.getElementById('ankiResetDefaults');
const ankiTestResult = document.getElementById('ankiTestResult');

// Preview
const ankiPreviewFront = document.getElementById('ankiPreviewFront');
const ankiPreviewBack = document.getElementById('ankiPreviewBack');
const ankiPreviewTags = document.getElementById('ankiPreviewTags');
const ankiPreviewWordLabel = document.getElementById('ankiPreviewWordLabel');

// Footer
const ankiSyncNowBtn = document.getElementById('ankiSyncNow');
const ankiSyncCancelBtn = document.getElementById('ankiSyncCancel');
const ankiProgressContainer = document.getElementById('ankiProgressContainer');
const ankiProgressFill = document.getElementById('ankiProgressFill');
const ankiSyncResult = document.getElementById('ankiSyncResult');

// Presets
const ankiPresetButtons = document.querySelectorAll('.anki-preset');

// Ignore DOM Elements
const ignoreSelectedBtn = document.getElementById('ignoreSelected');
const unignoreAllBtn = document.getElementById('unignoreAll');
const ignoredPanelEl = document.getElementById('ignoredPanel');
const ignoredCountEl = document.getElementById('ignoredCount');
const ignoredChipsEl = document.getElementById('ignoredChips');

// Guide DOM Elements
const ankiGuideToggle = document.getElementById('ankiGuideToggle');
const ankiGuideBody = document.getElementById('ankiGuideBody');
const ankiGuideChevron = document.getElementById('ankiGuideChevron');
const copyAnkiCodeBtn = document.getElementById('copyAnkiCode');
const ankiGuideTestBtn = document.getElementById('ankiGuideTestBtn');
const ankiGuideTestResult = document.getElementById('ankiGuideTestResult');

// State
let allWords = [];
let filteredWords = [];
let pendingAnkiKeys = new Set();
let pendingAnkiQueue = [];

function buildPendingKeys(queue) {
  const set = new Set();
  for (const item of queue || []) {
    if (!item?.word) continue;
    set.add(`${item.word}|${normalizeType(item.pos)}`);
  }
  return set;
}

async function loadPendingAnkiKeys() {
  try {
    const { ankiPendingQueue } = await chrome.storage.local.get('ankiPendingQueue');
    pendingAnkiQueue = Array.isArray(ankiPendingQueue) ? ankiPendingQueue : [];
    pendingAnkiKeys = buildPendingKeys(pendingAnkiQueue);
    console.log('[Anki] Pending queue loaded:', pendingAnkiKeys.size, 'keys:', [...pendingAnkiKeys]);
  } catch {
    pendingAnkiQueue = [];
    pendingAnkiKeys = new Set();
  }
}
let currentFilter = 'all';
let currentSort = 'frequency';
let searchQuery = '';
let currentPage = 1;
let pageSize = 50;

// Anki State
let ankiSelectedWords = new Set();
let ankiConnected = false;

// Ignored words state (keys hidden from the word grid)
let ignoredWords = new Set();

// Cache of Japanese surface forms currently in the configured Anki deck.
// Drives the "In Anki Deck" filter toggle. Refreshed on demand (and opportunistically after sync).
let ankiDeckWords = new Set();
let ankiDeckCards = [];
let ankiDeckCacheAt = 0;
let inAnkiDeckFilter = false;

// New DOM elements for the deck-filter row
const filterInAnkiDeckBtn = document.getElementById('filterInAnkiDeck');
const refreshAnkiDeckCacheBtn = document.getElementById('refreshAnkiDeckCache');
const ankiDeckCacheMetaEl = document.getElementById('ankiDeckCacheMeta');

const DEFAULT_ANKI_SETTINGS = {
  deckName: 'kaigi',
  includeFurigana: true,
  includePartOfSpeech: true,
  includeRomaji: true,
  includeCount: false,
  furiganaFormat: 'parentheses',
  modelName: 'Kaigi',
  frontFieldName: 'Front',
  backFieldName: 'Back',
  customTags: 'kaigi-meeting',
  autoTagByType: true,
  lastPresetApplied: 'reading'
};
let ankiSettings = { ...DEFAULT_ANKI_SETTINGS };

const ANKI_PRESETS = {
  minimal: {
    includeFurigana: false,
    furiganaFormat: 'parentheses',
    includePartOfSpeech: false,
    includeRomaji: false,
    includeCount: false
  },
  reading: {
    includeFurigana: true,
    furiganaFormat: 'parentheses',
    includePartOfSpeech: true,
    includeRomaji: false,
    includeCount: false
  },
  detailed: {
    includeFurigana: true,
    furiganaFormat: 'ruby',
    includePartOfSpeech: true,
    includeRomaji: true,
    includeCount: true
  },
  pronunciation: {
    includeFurigana: true,
    furiganaFormat: 'parentheses',
    includePartOfSpeech: false,
    includeRomaji: true,
    includeCount: false
  }
};

const SAMPLE_WORD = {
  japanese: '会議',
  reading: 'かいぎ',
  romaji: 'kaigi',
  english: 'meeting',
  type: 'noun',
  count: 12
};

// AnkiConnect model/field cache (cleared when the modal re-opens after TTL).
let _ankiModelCache = null; // { models: string[], fields: Map<string, string[]>, ts: number }
const MODEL_CACHE_TTL_MS = 30_000;

// Type colors for chart
const typeColors = {
  noun: '#4285F4',
  verb: '#34A853',
  particle: '#EA4335',
  adjective: '#FBBC04',
  adverb: '#A78BFA',
  counter: '#60A5FA',
  expression: '#F472B6',
  auxiliary: '#F87171',
  copula: '#2DD4BF',
  other: '#6B7280'
};

/**
 * Load the whole corpus for the dashboard.
 * Backfills any wordCache entries missing from the frequency store so the
 * dashboard reflects words translated in Chat/Gmail, not just Meet.
 */
async function loadData() {
  const data = await readAllFrequency();
  const { wordCache } = await new Promise(resolve => {
    chrome.storage.local.get(['wordCache'], resolve);
  });

  const hasExistingWords = Object.keys(data.words).length > 0;
  const hasCacheEntries = wordCache && typeof wordCache === 'object' && Object.keys(wordCache).length > 0;

  if (!hasExistingWords && !hasCacheEntries) return null;

  if (hasCacheEntries) {
    const missing = new Map();
    for (const [japanese, entry] of Object.entries(wordCache)) {
      const type = entry.type || 'other';
      const key = `${japanese}|${type}`;
      if (data.words[key]) continue;

      const ts = entry.lastUsed || Date.now();
      const record = {
        japanese,
        reading: entry.reading || '',
        romaji: entry.romaji || '',
        english: entry.english || '',
        type,
        count: 1,
        firstSeen: ts,
        lastSeen: ts
      };
      missing.set(key, record);
      data.words[key] = record;
    }

    if (missing.size > 0) {
      const added = await addMissingWords(missing);
      data.totalWords += added;
      data.uniqueWords = Object.keys(data.words).length;
      data.lastUpdated = Date.now();
      console.log(`[Frequency] Backfilled ${added} words from wordCache`);
    }
  }

  return data;
}

/**
 * Load Anki selections from chrome.storage.local
 */
async function loadAnkiSelections() {
  console.log('[Anki] Loading selections from storage...');
  return new Promise(resolve => {
    chrome.storage.local.get(['ankiSelectedWords'], (result) => {
      if (result.ankiSelectedWords) {
        ankiSelectedWords = new Set(result.ankiSelectedWords);
      }
      console.log('[Anki] Loaded', ankiSelectedWords.size, 'selections');
      resolve();
    });
  });
}

/**
 * Save Anki selections to chrome.storage.local
 */
function saveAnkiSelections() {
  console.log('[Anki] Saving', ankiSelectedWords.size, 'selections');
  chrome.storage.local.set({ ankiSelectedWords: [...ankiSelectedWords] });
  updateAnkiSelectedCount();
}

/**
 * Load ignored word keys from chrome.storage.local
 */
async function loadIgnoredWords() {
  return new Promise(resolve => {
    chrome.storage.local.get(['ignoredWords'], (result) => {
      if (result.ignoredWords) {
        ignoredWords = new Set(result.ignoredWords);
      }
      console.log('[Ignore] Loaded', ignoredWords.size, 'ignored words');
      resolve();
    });
  });
}

/**
 * Persist ignored word keys to chrome.storage.local
 */
function saveIgnoredWords() {
  console.log('[Ignore] Saving', ignoredWords.size, 'ignored words');
  chrome.storage.local.set({ ignoredWords: [...ignoredWords] });
}

/**
 * Load the cached Anki deck word set from chrome.storage.local.
 */
async function loadAnkiDeckWords() {
  return new Promise(resolve => {
    chrome.storage.local.get(['ankiDeckCards', 'ankiDeckCacheAt'], (result) => {
      if (Array.isArray(result.ankiDeckCards)) {
        ankiDeckCards = result.ankiDeckCards;
        ankiDeckWords = new Set(ankiDeckCards.map(c => c.japanese).filter(Boolean));
      }
      if (typeof result.ankiDeckCacheAt === 'number') {
        ankiDeckCacheAt = result.ankiDeckCacheAt;
      }
      resolve();
    });
  });
}

/**
 * Persist the Anki deck card cache.
 */
function saveAnkiDeckWords() {
  chrome.storage.local.set({
    ankiDeckCards,
    ankiDeckCacheAt
  });
}

function extractReadingFromFront(value) {
  if (!value) return '';
  const text = String(value).replace(/<[^>]+>/g, '');
  const paren = text.match(/[（(]([^）)]+)[）)]/);
  if (paren) return paren[1].trim();
  const ruby = text.match(/\[([^\]]+)\]/);
  return ruby ? ruby[1].trim() : '';
}

function stripHtml(value) {
  if (!value) return '';
  return String(value).replace(/<[^>]+>/g, '').trim();
}

/**
 * Extract the Japanese surface form from a card's front-field value.
 * The front may be plain ("会議"), parentheses ("会議 (かいぎ)"), or Anki ruby ("会議[かいぎ]").
 * All three start with the surface form, so we keep the leading run up to the first
 * space, "(", or "[". HTML tags from rich fields are stripped first.
 */
function extractSurfaceFromFront(value) {
  if (!value) return '';
  const text = String(value).replace(/<[^>]+>/g, '').trim();
  const m = text.match(/^[^\s(（\[［]+/);
  return m ? m[0] : '';
}

/**
 * Fetch the deck's note surface forms from AnkiConnect and update the cache.
 * Throws on connection failure so the caller can surface an error UI.
 */
async function refreshAnkiDeckCache() {
  const deckName = ankiSettings.deckName;
  const frontField = (ankiSettings.frontFieldName || 'Front').trim() || 'Front';
  const backField = (ankiSettings.backFieldName || 'Back').trim() || 'Back';
  console.log('[Anki] Refreshing deck cache for:', deckName, '(front field:', frontField + ')');
  const noteIds = await ankiConnect('findNotes', { query: `deck:"${deckName}"` });
  if (!noteIds || noteIds.length === 0) {
    ankiDeckCards = [];
    ankiDeckWords = new Set();
    ankiDeckCacheAt = Date.now();
    saveAnkiDeckWords();
    return;
  }
  const info = await ankiConnect('notesInfo', { notes: noteIds });
  const cards = [];
  const surfaces = new Set();
  // Mirror of src/content/chat/anki-model.js — the right-click quick-add uses this model.
  const KAIGI_MODEL_NAME = 'Kaigi';
  let loggedFirst = false;
  for (const note of info || []) {
    if (!loggedFirst) {
      console.log('[Anki] First note model:', note?.modelName, 'fields:', Object.keys(note?.fields || {}));
      loggedFirst = true;
    }
    const fields = note?.fields || {};
    let japanese = '';
    let reading = '';
    let english = '';
    if (note?.modelName === KAIGI_MODEL_NAME) {
      japanese = stripHtml(fields.Word?.value);
      reading = stripHtml(fields.Reading?.value);
      english = stripHtml(fields.Meaning?.value);
    } else {
      const frontVal = fields[frontField]?.value;
      const backVal = fields[backField]?.value;
      japanese = extractSurfaceFromFront(frontVal);
      reading = extractReadingFromFront(frontVal);
      english = stripHtml(backVal);
    }
    if (!japanese) {
      // Defensive fallback: pick the first field with CJK characters.
      for (const [, f] of Object.entries(fields)) {
        const v = stripHtml(f?.value);
        if (v && /[぀-ヿ㐀-鿿]/.test(v)) { japanese = v; break; }
      }
    }
    if (!japanese) continue;
    cards.push({ japanese, reading, english, noteId: note?.noteId ?? null });
    surfaces.add(japanese);
  }
  ankiDeckCards = cards;
  ankiDeckWords = surfaces;
  ankiDeckCacheAt = Date.now();
  saveAnkiDeckWords();
}

/**
 * Render the meta hint: word count + relative timestamp, or an error state.
 */
function renderAnkiDeckCacheMeta(error) {
  if (!ankiDeckCacheMetaEl) return;
  if (error) {
    ankiDeckCacheMetaEl.textContent = error;
    ankiDeckCacheMetaEl.classList.add('error');
    return;
  }
  ankiDeckCacheMetaEl.classList.remove('error');
  if (!ankiDeckCacheAt) {
    ankiDeckCacheMetaEl.textContent = 'Click Refresh to load deck';
    return;
  }
  const ageMs = Date.now() - ankiDeckCacheAt;
  const ageMin = Math.round(ageMs / 60000);
  const ageStr = ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
  ankiDeckCacheMetaEl.textContent = `${ankiDeckWords.size.toLocaleString()} words · updated ${ageStr}`;
}

/**
 * Load Anki settings from chrome.storage.sync
 */
async function loadAnkiSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(['ankiSettings'], (result) => {
      ankiSettings = { ...DEFAULT_ANKI_SETTINGS, ...(result.ankiSettings || {}) };
      if (ankiSettings.deckName === 'Kaigi Meeting') {
        ankiSettings.deckName = 'kaigi';
        saveAnkiSettings();
      }
      resolve();
    });
  });
}

/**
 * Save Anki settings to chrome.storage.sync
 */
function saveAnkiSettings() {
  chrome.storage.sync.set({ ankiSettings });
}

/**
 * Build an AnkiConnect note payload from a word and the user's settings.
 */
function buildAnkiNote(word, settings) {
  const type = normalizeType(word.type);

  let front;
  if (settings.includeFurigana && word.reading) {
    front = settings.furiganaFormat === 'ruby'
      ? `${word.japanese}[${word.reading}]`
      : `${word.japanese} (${word.reading})`;
  } else {
    front = word.japanese;
  }

  const backLines = [];
  if (word.english) backLines.push(word.english);
  if (settings.includePartOfSpeech) backLines.push(`Type: ${type}`);
  if (settings.includeRomaji && word.romaji) backLines.push(`Romaji: ${word.romaji}`);
  if (settings.includeCount && typeof word.count === 'number') {
    backLines.push(`Count: ${word.count}x`);
  }
  const back = backLines.join('<br>');

  const frontField = (settings.frontFieldName || 'Front').trim() || 'Front';
  const backField = (settings.backFieldName || 'Back').trim() || 'Back';
  const modelName = (settings.modelName || 'Basic').trim() || 'Basic';

  const tags = (settings.customTags || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
  if (settings.autoTagByType) tags.push(type);

  return {
    deckName: settings.deckName,
    modelName,
    fields: { [frontField]: front, [backField]: back },
    tags
  };
}

/**
 * Update the Anki selected count in the summary card
 */
function updateAnkiSelectedCount() {
  ankiSelectedValueEl.textContent = ankiSelectedWords.size.toLocaleString();
  syncToAnkiBtn.disabled = ankiSelectedWords.size === 0;
  ignoreSelectedBtn.disabled = ankiSelectedWords.size === 0;
  console.log('[Anki] Updated count:', ankiSelectedWords.size, 'button disabled:', syncToAnkiBtn.disabled);
  if (ankiSettingsModal && ankiSettingsModal.open) {
    refreshSelectedCount();
    renderAnkiPreview();
  }
}

/**
 * Render the Ignored Words panel as chips; hide container when empty.
 */
function renderIgnoredPanel() {
  if (ignoredWords.size === 0) {
    ignoredPanelEl.style.display = 'none';
    ignoredChipsEl.innerHTML = '';
    return;
  }

  ignoredPanelEl.style.display = 'block';
  ignoredCountEl.textContent = ignoredWords.size.toLocaleString();

  const wordByKey = new Map();
  for (const w of allWords) {
    wordByKey.set(`${w.japanese}|${normalizeType(w.type)}`, w);
  }

  ignoredChipsEl.innerHTML = [...ignoredWords].map(key => {
    const word = wordByKey.get(key);
    const japanese = word ? word.japanese : key.split('|')[0];
    const type = word ? normalizeType(word.type) : (key.split('|')[1] || 'other');
    return `
      <span class="ignored-chip">
        <span class="ignored-chip-label ${type}">${escapeHtml(japanese)}</span>
        <button class="ignored-chip-remove" data-word-key="${escapeHtml(key)}" title="Unignore" aria-label="Unignore ${escapeHtml(japanese)}">×</button>
      </span>
    `;
  }).join('');
}

const ANKI_ORIGIN = 'http://localhost:8765/*';

async function hasAnkiPermission() {
  return chrome.permissions.contains({ origins: [ANKI_ORIGIN] });
}

async function requestAnkiPermission() {
  return chrome.permissions.request({ origins: [ANKI_ORIGIN] });
}

/**
 * AnkiConnect API helper
 */
async function ankiConnect(action, params = {}) {
  console.log('[Anki] API call:', action, params);
  try {
    const resp = await fetch('http://localhost:8765', {
      method: 'POST',
      body: JSON.stringify({ action, version: 6, params })
    });
    const data = await resp.json();
    console.log('[Anki] API response:', action, data);
    if (data.error) throw new Error(data.error);
    return data.result;
  } catch (error) {
    console.error('[Anki] API error:', action, error);
    throw error;
  }
}

/**
 * Check AnkiConnect connection status
 */
async function checkAnkiConnection() {
  console.log('[Anki] Checking connection...');
  if (!(await hasAnkiPermission())) {
    ankiConnected = false;
    ankiStatusEl.className = 'anki-status-dot disconnected';
    ankiStatusEl.title = 'AnkiConnect: permission not granted (click Sync to Anki to enable)';
    console.log('[Anki] No localhost permission; skipping connection check');
    updateAnkiSelectedCount();
    return;
  }
  try {
    const result = await ankiConnect('version');
    ankiConnected = true;
    ankiStatusEl.className = 'anki-status-dot connected';
    ankiStatusEl.title = 'AnkiConnect: connected';
    console.log('[Anki] Connected! Version:', result);
    flushPendingFromFrequency();
  } catch (error) {
    ankiConnected = false;
    ankiStatusEl.className = 'anki-status-dot disconnected';
    ankiStatusEl.title = 'AnkiConnect: disconnected';
    console.warn('[Anki] Connection failed:', error);
  }
  console.log('[Anki] ankiConnected =', ankiConnected);
  updateAnkiSelectedCount();
}

/**
 * Calculate days since first word was tracked
 */
function calculateDaysTracking(words) {
  if (words.length === 0) return 0;

  let earliest = Infinity;
  for (const word of words) {
    if (word.firstSeen < earliest) {
      earliest = word.firstSeen;
    }
  }

  const now = Date.now();
  const days = Math.ceil((now - earliest) / (1000 * 60 * 60 * 24));
  return Math.max(1, days);
}

/**
 * Calculate type distribution
 */
function calculateTypeDistribution(words) {
  const distribution = {};

  for (const word of words) {
    const type = normalizeType(word.type);
    distribution[type] = (distribution[type] || 0) + word.count;
  }

  return distribution;
}

/**
 * Normalize word type to a known category
 */
function normalizeType(type) {
  const normalized = type?.toLowerCase() || 'other';
  const knownTypes = ['noun', 'verb', 'particle', 'adjective', 'adverb', 'counter', 'expression', 'auxiliary', 'copula'];
  return knownTypes.includes(normalized) ? normalized : 'other';
}

/**
 * Render the type distribution chart
 */
function renderTypeChart(distribution) {
  const total = Object.values(distribution).reduce((a, b) => a + b, 0);
  if (total === 0) {
    typeChartEl.innerHTML = '<p style="color: #6B7280; text-align: center;">No data yet</p>';
    return;
  }

  // Sort by count
  const sorted = Object.entries(distribution)
    .sort((a, b) => b[1] - a[1]);

  const maxCount = sorted[0][1];

  typeChartEl.innerHTML = sorted.map(([type, count]) => {
    const percentage = (count / maxCount) * 100;
    const displayPercentage = ((count / total) * 100).toFixed(1);

    return `
      <div class="chart-row">
        <span class="chart-label">${type}</span>
        <div class="chart-bar-container">
          <div class="chart-bar ${type}" style="width: 0%;" data-width="${percentage}">
            <span>${count.toLocaleString()} (${displayPercentage}%)</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Animate bars
  requestAnimationFrame(() => {
    const bars = typeChartEl.querySelectorAll('.chart-bar');
    bars.forEach(bar => {
      bar.style.width = bar.dataset.width + '%';
    });
  });
}

/**
 * Render the word grid
 */
function renderWordGrid(words) {
  if (words.length === 0) {
    wordGridEl.style.display = 'none';
    emptyStateEl.style.display = 'block';
    const hintEl = emptyStateEl.querySelector('.empty-hint');
    if (hintEl) {
      hintEl.textContent = inAnkiDeckFilter
        ? "Your Anki deck cache is empty. Click Refresh, or check that your deck name matches in Sync to Anki."
        : 'Translate some captions in Google Meet to start building your vocabulary';
    }
    return;
  }

  emptyStateEl.style.display = 'none';
  wordGridEl.style.display = 'grid';

  wordGridEl.innerHTML = words.map(word => {
    const type = normalizeType(word.type);
    const japanese = highlightSearch(escapeHtml(word.japanese));
    const romaji = highlightSearch(escapeHtml(word.romaji));
    const english = highlightSearch(escapeHtml(word.english));
    const wordKey = `${word.japanese}|${type}`;
    const isSelected = ankiSelectedWords.has(wordKey);

    const reading = word.ankiOnly ? highlightSearch(escapeHtml(word.reading || '')) : romaji;
    const countLabel = word.ankiOnly ? '—' : `${word.count}x`;
    const ankiBadge = word.fromAnki ? '<span class="anki-badge" title="In your Anki deck">anki</span>' : '';
    const queuedBadge = pendingAnkiKeys.has(wordKey)
      ? '<span class="anki-badge queued" title="Waiting to sync to Anki">queued for anki</span>'
      : '';
    const cardClasses = ['word-card'];
    if (isSelected) cardClasses.push('anki-selected');
    if (word.ankiOnly) cardClasses.push('anki-only');

    return `
      <div class="${cardClasses.join(' ')}">
        <div class="word-card-header">
          <span class="word-japanese ${type}">${japanese}</span>
          <div class="word-card-actions">
            ${queuedBadge}
            ${ankiBadge}
            <span class="word-count">${countLabel}</span>
            <label class="anki-checkbox">
              <input type="checkbox" class="anki-check-input" data-word-key="${escapeHtml(wordKey)}" ${isSelected ? 'checked' : ''}>
            </label>
          </div>
        </div>
        <div class="word-reading">${reading}</div>
        <span class="word-type-badge ${type}">${type}</span>
        <div class="word-english">${english}</div>
      </div>
    `;
  }).join('');
}

/**
 * Escape HTML characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

/**
 * Highlight search query in text
 */
function highlightSearch(text) {
  if (!searchQuery) return text;

  const regex = new RegExp(`(${escapeRegex(searchQuery)})`, 'gi');
  return text.replace(regex, '<span class="highlight">$1</span>');
}

/**
 * Escape regex special characters
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Filter words by type
 */
function filterWords(words, type) {
  if (type === 'all') return words;
  return words.filter(w => normalizeType(w.type) === type);
}

/**
 * Filter words by search query
 */
function searchWords(words, query) {
  if (!query) return words;

  const q = query.toLowerCase();
  return words.filter(w =>
    w.japanese.includes(query) ||
    w.romaji.toLowerCase().includes(q) ||
    w.english.toLowerCase().includes(q) ||
    (w.reading && w.reading.includes(query))
  );
}

/**
 * Sort words
 */
function sortWords(words, sortBy) {
  const sorted = [...words];

  switch (sortBy) {
    case 'frequency':
      sorted.sort((a, b) => b.count - a.count);
      break;
    case 'alphabetical':
      sorted.sort((a, b) => a.japanese.localeCompare(b.japanese, 'ja'));
      break;
    case 'recent':
      sorted.sort((a, b) => b.lastSeen - a.lastSeen);
      break;
  }

  return sorted;
}

/**
 * Apply all filters and render
 */
function applyFiltersAndRender() {
  let result;
  if (inAnkiDeckFilter) {
    const trackedByKey = new Map(allWords.map(w => [w.japanese, w]));
    result = ankiDeckCards.map(card => {
      const tracked = trackedByKey.get(card.japanese);
      if (tracked) return { ...tracked, fromAnki: true };
      return {
        japanese: card.japanese,
        reading: card.reading || '',
        romaji: '',
        english: card.english || '',
        type: 'other',
        count: 0,
        firstSeen: null,
        lastSeen: null,
        fromAnki: true,
        ankiOnly: true,
      };
    });
    result = result.filter(w => !ignoredWords.has(`${w.japanese}|${normalizeType(w.type)}`));
  } else {
    result = filterWords(allWords, currentFilter);
    result = result.filter(w => !ignoredWords.has(`${w.japanese}|${normalizeType(w.type)}`));
  }

  if (inAnkiDeckFilter && pendingAnkiQueue.length) {
    const presentKeys = new Set(result.map(w => `${w.japanese}|${normalizeType(w.type)}`));
    for (const q of pendingAnkiQueue) {
      if (!q?.word) continue;
      const key = `${q.word}|${normalizeType(q.pos)}`;
      if (presentKeys.has(key)) continue;
      if (ignoredWords.has(key)) continue;
      result.push({
        japanese: q.word,
        reading: q.reading || '',
        romaji: '',
        english: q.english || '',
        type: normalizeType(q.pos),
        count: 0,
        firstSeen: null,
        lastSeen: null,
        fromAnki: false,
        ankiOnly: true,
      });
      presentKeys.add(key);
    }
  }

  result = searchWords(result, searchQuery);
  result = sortWords(result, currentSort);
  filteredWords = result;

  const total = result.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const start = (currentPage - 1) * pageSize;
  const slice = result.slice(start, start + pageSize);

  renderWordGrid(slice);
  renderPagination(total, currentPage, pageSize);
}

/**
 * Build the pagination control bar.
 */
function renderPagination(total, page, size) {
  if (!paginationEl) return;
  const totalPages = Math.ceil(total / size);
  if (totalPages <= 1) {
    paginationEl.innerHTML = '';
    paginationEl.style.display = 'none';
    return;
  }
  paginationEl.style.display = 'flex';

  const pages = [];
  const window = 2;
  const add = (p) => pages.push(p);
  add(1);
  const from = Math.max(2, page - window);
  const to = Math.min(totalPages - 1, page + window);
  if (from > 2) add('…');
  for (let p = from; p <= to; p++) add(p);
  if (to < totalPages - 1) add('…');
  if (totalPages > 1) add(totalPages);

  const btn = (label, target, opts = {}) => {
    const disabled = opts.disabled ? ' disabled' : '';
    const active = opts.active ? ' active' : '';
    const data = target == null ? '' : ` data-page="${target}"`;
    return `<button class="page-btn${active}"${data}${disabled}>${label}</button>`;
  };

  let html = '';
  html += btn('« Prev', page - 1, { disabled: page <= 1 });
  for (const p of pages) {
    if (p === '…') html += '<span class="page-ellipsis">…</span>';
    else html += btn(String(p), p, { active: p === page });
  }
  html += btn('Next »', page + 1, { disabled: page >= totalPages });

  const start = (page - 1) * size + 1;
  const end = Math.min(total, page * size);
  html += `<span class="page-info">${start}–${end} of ${total}</span>`;

  paginationEl.innerHTML = html;
}

/**
 * Export data as JSON
 */
function exportJson() {
  const data = {
    exportedAt: new Date().toISOString(),
    totalWords: allWords.reduce((sum, w) => sum + w.count, 0),
    uniqueWords: allWords.length,
    words: allWords.map(w => ({
      japanese: w.japanese,
      reading: w.reading,
      romaji: w.romaji,
      english: w.english,
      type: w.type,
      count: w.count,
      firstSeen: new Date(w.firstSeen).toISOString(),
      lastSeen: new Date(w.lastSeen).toISOString()
    }))
  };

  downloadFile(
    JSON.stringify(data, null, 2),
    'word-frequency.json',
    'application/json'
  );
}

/**
 * Export data as CSV
 */
function exportCsv() {
  const headers = ['Japanese', 'Reading', 'Romaji', 'English', 'Type', 'Count', 'First Seen', 'Last Seen'];
  const rows = allWords.map(w => [
    w.japanese,
    w.reading || '',
    w.romaji,
    w.english,
    w.type,
    w.count,
    new Date(w.firstSeen).toISOString(),
    new Date(w.lastSeen).toISOString()
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  downloadFile(csv, 'word-frequency.csv', 'text/csv');
}

/**
 * Download a file
 */
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Initialize the page
 */
async function init() {
  // Load Anki state in parallel with word data
  const [data] = await Promise.all([
    loadData(),
    loadAnkiSelections(),
    loadIgnoredWords(),
    loadAnkiSettings(),
    loadAnkiDeckWords()
  ]);
  renderAnkiDeckCacheMeta();

  console.log('[Anki] Loaded selections:', ankiSelectedWords.size, 'words');
  console.log('[Anki] Loaded settings, deck:', ankiSettings.deckName);

  // Check Anki connection (fire-and-forget)
  checkAnkiConnection();

  // Load pending Anki queue so word cards can show a "queued for anki" chip.
  loadPendingAnkiKeys().then(() => applyFiltersAndRender()).catch(() => {});
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.ankiPendingQueue) return;
      const q = Array.isArray(changes.ankiPendingQueue.newValue)
        ? changes.ankiPendingQueue.newValue
        : [];
      pendingAnkiQueue = q;
      pendingAnkiKeys = buildPendingKeys(q);
      applyFiltersAndRender();
    });
  } catch {}

  // Auto-refresh deck cache if permission is already granted (fire-and-forget).
  hasAnkiPermission().then(granted => {
    if (!granted) return;
    refreshAnkiDeckCache()
      .then(() => {
        renderAnkiDeckCacheMeta();
        applyFiltersAndRender();
      })
      .catch(err => {
        console.warn('[Anki] Auto-refresh failed:', err);
        renderAnkiDeckCacheMeta(err?.message ? 'Anki: ' + err.message : 'Anki not reachable');
      });
  });

  loadingStateEl.style.display = 'none';

  if (!data || !data.words || Object.keys(data.words).length === 0) {
    totalWordsEl.textContent = '0';
    uniqueWordsEl.textContent = '0';
    daysTrackingEl.textContent = '0';
    emptyStateEl.style.display = 'block';
    wordGridEl.style.display = 'none';
    typeChartEl.innerHTML = '<p style="color: #6B7280; text-align: center;">No data yet</p>';
    renderIgnoredPanel();
    updateAnkiSelectedCount();
    return;
  }

  // Convert words object to array
  allWords = Object.values(data.words);

  // Update summary
  totalWordsEl.textContent = data.totalWords.toLocaleString();
  uniqueWordsEl.textContent = data.uniqueWords.toLocaleString();
  daysTrackingEl.textContent = calculateDaysTracking(allWords);

  // Render chart
  const distribution = calculateTypeDistribution(allWords);
  renderTypeChart(distribution);

  // Render word grid
  applyFiltersAndRender();
  renderIgnoredPanel();
  updateAnkiSelectedCount();
}

// Event Listeners
document.querySelectorAll('.type-chips .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.type-chips .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.type;
    currentPage = 1;
    applyFiltersAndRender();
  });
});

// "In Anki Deck" filter toggle — composes with the type chips (independent boolean).
if (filterInAnkiDeckBtn) {
  filterInAnkiDeckBtn.addEventListener('click', () => {
    inAnkiDeckFilter = !inAnkiDeckFilter;
    filterInAnkiDeckBtn.setAttribute('aria-pressed', String(inAnkiDeckFilter));
    currentPage = 1;
    applyFiltersAndRender();
  });
}

// Refresh deck cache from AnkiConnect.
if (refreshAnkiDeckCacheBtn) {
  refreshAnkiDeckCacheBtn.addEventListener('click', async () => {
    const granted = await requestAnkiPermission();
    if (!granted) {
      renderAnkiDeckCacheMeta('Permission denied for AnkiConnect');
      return;
    }
    refreshAnkiDeckCacheBtn.disabled = true;
    const originalLabel = refreshAnkiDeckCacheBtn.textContent;
    refreshAnkiDeckCacheBtn.textContent = 'Refreshing…';
    try {
      await refreshAnkiDeckCache();
      renderAnkiDeckCacheMeta();
      applyFiltersAndRender();
    } catch (err) {
      console.warn('[Anki] Deck cache refresh failed:', err);
      renderAnkiDeckCacheMeta(err?.message ? 'Anki: ' + err.message : 'Anki not reachable');
    } finally {
      refreshAnkiDeckCacheBtn.disabled = false;
      refreshAnkiDeckCacheBtn.textContent = originalLabel;
    }
  });
}

sortBySelect.addEventListener('change', () => {
  currentSort = sortBySelect.value;
  currentPage = 1;
  applyFiltersAndRender();
});

if (pageSizeSelect) {
  pageSizeSelect.addEventListener('change', () => {
    const next = parseInt(pageSizeSelect.value, 10);
    if (Number.isFinite(next) && next > 0) {
      pageSize = next;
      currentPage = 1;
      applyFiltersAndRender();
    }
  });
}

if (paginationEl) {
  paginationEl.addEventListener('click', (e) => {
    const target = e.target.closest('button[data-page]');
    if (!target || target.disabled) return;
    const next = parseInt(target.dataset.page, 10);
    if (!Number.isFinite(next)) return;
    currentPage = next;
    applyFiltersAndRender();
    wordGridEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

let searchTimeout;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchQuery = searchInput.value.trim();
    currentPage = 1;
    applyFiltersAndRender();
  }, 200);
});

exportJsonBtn.addEventListener('click', exportJson);
exportCsvBtn.addEventListener('click', exportCsv);

// Anki checkbox delegation
wordGridEl.addEventListener('change', (e) => {
  if (!e.target.classList.contains('anki-check-input')) return;
  const wordKey = e.target.dataset.wordKey;
  console.log('[Anki] Checkbox toggled:', wordKey, '→', e.target.checked);
  const card = e.target.closest('.word-card');
  if (e.target.checked) {
    ankiSelectedWords.add(wordKey);
    card.classList.add('anki-selected');
  } else {
    ankiSelectedWords.delete(wordKey);
    card.classList.remove('anki-selected');
  }
  saveAnkiSelections();
});

// Batch selection
selectAllBtn.addEventListener('click', () => {
  for (const word of filteredWords) {
    const type = normalizeType(word.type);
    ankiSelectedWords.add(`${word.japanese}|${type}`);
  }
  console.log('[Anki] Select All: added', filteredWords.length, 'filtered words');
  saveAnkiSelections();
  applyFiltersAndRender();
});

deselectAllBtn.addEventListener('click', () => {
  ankiSelectedWords.clear();
  console.log('[Anki] Deselect All: cleared all selections');
  saveAnkiSelections();
  applyFiltersAndRender();
});

// Ignore Selected: hide currently checked words from the grid
// (also removes them from the Anki queue — a word you don't want to see shouldn't sync)
ignoreSelectedBtn.addEventListener('click', () => {
  if (ankiSelectedWords.size === 0) return;
  const moved = ankiSelectedWords.size;
  for (const key of ankiSelectedWords) {
    ignoredWords.add(key);
  }
  ankiSelectedWords.clear();
  console.log('[Ignore] Ignored', moved, 'selected words');
  saveIgnoredWords();
  saveAnkiSelections();
  renderIgnoredPanel();
  applyFiltersAndRender();
});

unignoreAllBtn.addEventListener('click', () => {
  const count = ignoredWords.size;
  if (count === 0) return;
  ignoredWords.clear();
  console.log('[Ignore] Unignored all', count, 'words');
  saveIgnoredWords();
  renderIgnoredPanel();
  applyFiltersAndRender();
});

// Per-chip unignore (delegated)
ignoredChipsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.ignored-chip-remove');
  if (!btn) return;
  const wordKey = btn.dataset.wordKey;
  if (!ignoredWords.has(wordKey)) return;
  ignoredWords.delete(wordKey);
  console.log('[Ignore] Unignored:', wordKey);
  saveIgnoredWords();
  renderIgnoredPanel();
  applyFiltersAndRender();
});

/**
 * Populate the card-settings inputs from the current ankiSettings object.
 * Only touches fields the modal owns — deck/model/field selects are rebuilt
 * from AnkiConnect responses in openAnkiModal() / onModelChanged().
 */
function hydrateAnkiSettingsInputs() {
  ankiIncludeFuriganaInput.checked = ankiSettings.includeFurigana;
  ankiIncludePartOfSpeechInput.checked = ankiSettings.includePartOfSpeech;
  ankiIncludeRomajiInput.checked = ankiSettings.includeRomaji;
  ankiIncludeCountInput.checked = ankiSettings.includeCount;
  ankiFuriganaFormatSelect.value = ankiSettings.furiganaFormat;
  ankiCustomTagsInput.value = ankiSettings.customTags;
  ankiAutoTagByTypeInput.checked = ankiSettings.autoTagByType;
}

/**
 * Pick a word to render in the preview.
 * Prefers the most-frequent selected word so the preview feels live;
 * falls back to the canned sample when no selection exists yet.
 */
function getPreviewWord() {
  if (ankiSelectedWords.size === 0 || allWords.length === 0) return SAMPLE_WORD;
  let best = null;
  for (const key of ankiSelectedWords) {
    const [japanese, type] = key.split('|');
    const w = allWords.find(x => x.japanese === japanese && normalizeType(x.type) === type);
    if (!w) continue;
    if (!best || (w.count || 0) > (best.count || 0)) best = w;
  }
  return best || SAMPLE_WORD;
}

/**
 * Render the preview card using buildAnkiNote on the preview word.
 * Keeps WYSIWYG parity with the real sync.
 */
function renderAnkiPreview() {
  const word = getPreviewWord();
  const note = buildAnkiNote(word, ankiSettings);

  ankiPreviewWordLabel.textContent = word.japanese;

  const frontField = (ankiSettings.frontFieldName || 'Front').trim() || 'Front';
  const backField = (ankiSettings.backFieldName || 'Back').trim() || 'Back';
  ankiPreviewFront.innerHTML = note.fields[frontField] ?? '';
  ankiPreviewBack.innerHTML = note.fields[backField] ?? '';

  ankiPreviewTags.innerHTML = '';
  for (const tag of note.tags) {
    const span = document.createElement('span');
    span.className = 'anki-preview-tag';
    span.textContent = tag;
    ankiPreviewTags.appendChild(span);
  }
}

/**
 * Update `aria-pressed` on preset chips to reflect `lastPresetApplied`.
 */
function updatePresetChipStates() {
  const active = ankiSettings.lastPresetApplied;
  for (const btn of ankiPresetButtons) {
    btn.setAttribute('aria-pressed', btn.dataset.preset === active ? 'true' : 'false');
  }
}

/**
 * Apply a preset by merging its values onto ankiSettings and re-rendering.
 */
function applyPreset(name) {
  const preset = ANKI_PRESETS[name];
  if (!preset) return;
  ankiSettings = { ...ankiSettings, ...preset, lastPresetApplied: name };
  saveAnkiSettings();
  hydrateAnkiSettingsInputs();
  updatePresetChipStates();
  renderAnkiPreview();
}

/**
 * Reset every card-format setting to the defaults. Preserves the currently
 * chosen deck so the user doesn't lose their destination.
 */
function resetToDefaults() {
  const keepDeck = ankiSettings.deckName;
  ankiSettings = { ...DEFAULT_ANKI_SETTINGS, deckName: keepDeck };
  saveAnkiSettings();
  hydrateAnkiSettingsInputs();
  // Re-set selects to match restored values where possible.
  if ([...ankiDeckSelect.options].some(o => o.value === keepDeck)) {
    ankiDeckSelect.value = keepDeck;
  }
  if ([...ankiModelSelect.options].some(o => o.value === ankiSettings.modelName)) {
    ankiModelSelect.value = ankiSettings.modelName;
    onModelChanged();
  } else {
    validateSelectedFields();
  }
  updatePresetChipStates();
  renderAnkiPreview();
}

/**
 * Update the "N words selected" subtitle and the Sync button label.
 */
function refreshSelectedCount() {
  const n = ankiSelectedWords.size;
  ankiModalCount.textContent = `${n} word${n === 1 ? '' : 's'} selected`;
  ankiSyncNowBtn.textContent = n > 0 ? `Sync ${n}` : 'Sync';
  ankiSyncNowBtn.disabled = n === 0;
}

/**
 * Populate the deck select. Keeps the currently-stored deck selected if it
 * exists on the user's Anki; appends a "+ Create new deck..." sentinel.
 */
function populateDeckSelect(decks) {
  ankiDeckSelect.innerHTML = '';
  for (const deck of decks) {
    const opt = document.createElement('option');
    opt.value = deck;
    opt.textContent = deck;
    if (deck === ankiSettings.deckName) opt.selected = true;
    ankiDeckSelect.appendChild(opt);
  }
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ Create new deck...';
  ankiDeckSelect.appendChild(newOpt);
  if (!decks.includes(ankiSettings.deckName) && decks.length > 0) {
    // Fallback: stored deck doesn't exist; pick the first.
    ankiDeckSelect.value = decks[0];
    ankiSettings.deckName = decks[0];
    saveAnkiSettings();
  }
}

/**
 * Populate the note-type select from AnkiConnect's modelNames.
 */
function populateModelSelect(models) {
  ankiModelSelect.innerHTML = '';
  for (const model of models) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    if (model === ankiSettings.modelName) opt.selected = true;
    ankiModelSelect.appendChild(opt);
  }
  if (!models.includes(ankiSettings.modelName) && models.length > 0) {
    ankiModelSelect.value = models[0];
    ankiSettings.modelName = models[0];
    saveAnkiSettings();
  }
}

/**
 * Populate Front/Back field selects from a model's field list.
 * Keeps the stored field choice if present; otherwise snaps to a sensible
 * default (first field for Front, second or first for Back).
 */
function populateFieldSelects(fields) {
  const build = (select, storedKey, fallbackIndex) => {
    select.innerHTML = '';
    for (const field of fields) {
      const opt = document.createElement('option');
      opt.value = field;
      opt.textContent = field;
      select.appendChild(opt);
    }
    const stored = ankiSettings[storedKey];
    if (fields.includes(stored)) {
      select.value = stored;
    } else if (fields.length > 0) {
      const fb = fields[Math.min(fallbackIndex, fields.length - 1)];
      select.value = fb;
      ankiSettings[storedKey] = fb;
      saveAnkiSettings();
    }
  };
  build(ankiFrontFieldSelect, 'frontFieldName', 0);
  build(ankiBackFieldSelect, 'backFieldName', 1);
  validateSelectedFields();
}

/**
 * Show or clear the field warning based on whether the configured Front/Back
 * fields exist on the selected model.
 */
function validateSelectedFields() {
  const missing = [];
  const frontOptions = [...ankiFrontFieldSelect.options].map(o => o.value);
  const backOptions = [...ankiBackFieldSelect.options].map(o => o.value);
  if (frontOptions.length && !frontOptions.includes(ankiSettings.frontFieldName)) missing.push('Front');
  if (backOptions.length && !backOptions.includes(ankiSettings.backFieldName)) missing.push('Back');
  if (missing.length === 0) {
    ankiFieldWarning.hidden = true;
    return;
  }
  ankiFieldWarning.hidden = false;
  ankiFieldWarning.textContent = `${missing.join(' and ')} field not found on this note type. Pick an existing field or sync will fail.`;
}

/**
 * Fetch (with 30s cache) the field list for a given note type.
 */
async function loadAnkiModelFields(modelName) {
  if (_ankiModelCache && _ankiModelCache.fields.has(modelName)) {
    return _ankiModelCache.fields.get(modelName);
  }
  const fields = await ankiConnect('modelFieldNames', { modelName });
  if (_ankiModelCache) _ankiModelCache.fields.set(modelName, fields);
  return fields;
}

/**
 * Handle model-select changes: refresh fields, validate, re-render preview.
 */
async function onModelChanged() {
  const model = ankiModelSelect.value;
  ankiSettings.modelName = model;
  saveAnkiSettings();
  try {
    const fields = await loadAnkiModelFields(model);
    populateFieldSelects(fields);
  } catch (err) {
    console.warn('[Anki] Could not fetch fields for', model, err);
    // Keep current selects; surface a warning.
    ankiFieldWarning.hidden = false;
    ankiFieldWarning.textContent = 'Could not read fields for this note type. Make sure Anki is running.';
  }
  renderAnkiPreview();
}

/**
 * Update the small connection status banner at the top of the Destination
 * section, reflecting the latest checkAnkiConnection result.
 */
function renderConnStatusBanner() {
  if (!ankiConnStatusRow) return;
  if (ankiConnected) {
    ankiConnStatusRow.hidden = true;
    return;
  }
  ankiConnStatusRow.hidden = false;
  ankiConnStatusRow.className = 'anki-conn-status disconnected';
  ankiConnStatusRow.textContent = 'Anki not reachable. Deck/note-type lists may be stale. Open Anki and Test connection in Advanced.';
}

/**
 * Open the settings modal. Parallel-fetches decks, models, and fields for
 * the current model; falls back gracefully when AnkiConnect is unreachable.
 */
async function openAnkiModal() {
  const granted = await requestAnkiPermission();
  if (!granted) {
    alert('Anki sync needs permission to talk to AnkiConnect on http://localhost:8765. ' +
      'Click "Sync to Anki" again and choose "Allow" to enable it.');
    return;
  }

  // Reset transient UI.
  ankiSyncResult.hidden = true;
  ankiProgressContainer.hidden = true;
  ankiProgressFill.style.width = '0%';
  ankiTestResult.hidden = true;
  ankiFieldWarning.hidden = true;

  hydrateAnkiSettingsInputs();
  updatePresetChipStates();
  refreshSelectedCount();
  renderAnkiPreview();

  ankiSettingsModal.showModal();

  await checkAnkiConnection();
  renderConnStatusBanner();

  // Invalidate stale cache.
  if (_ankiModelCache && Date.now() - _ankiModelCache.ts > MODEL_CACHE_TTL_MS) {
    _ankiModelCache = null;
  }

  try {
    const [decks, models] = await Promise.all([
      ankiConnect('deckNames'),
      ankiConnect('modelNames')
    ]);
    _ankiModelCache = _ankiModelCache || { models: [], fields: new Map(), ts: Date.now() };
    _ankiModelCache.models = models;
    populateDeckSelect(decks);
    populateModelSelect(models);
    const fields = await loadAnkiModelFields(ankiModelSelect.value);
    populateFieldSelects(fields);
  } catch (err) {
    console.warn('[Anki] Could not populate modal selects from AnkiConnect:', err);
    // Selects already have default options from the HTML; leave them alone.
  }

  renderAnkiPreview();
}

function closeAnkiModal() {
  if (ankiSettingsModal.open) ankiSettingsModal.close();
}

// Sync to Anki button -> open the modal
syncToAnkiBtn.addEventListener('click', () => {
  console.log('[Anki] Sync button clicked, opening settings modal');
  openAnkiModal();
});

// Close via X button, Cancel button, or backdrop click
ankiModalClose.addEventListener('click', closeAnkiModal);
ankiSyncCancelBtn.addEventListener('click', closeAnkiModal);
ankiSettingsModal.addEventListener('click', (e) => {
  if (e.target === ankiSettingsModal) closeAnkiModal();
});

// Deck select: handle "+ Create new deck..." sentinel (same prompt flow as before).
ankiDeckSelect.addEventListener('change', () => {
  if (ankiDeckSelect.value === '__new__') {
    const name = prompt('Enter new deck name:');
    if (name && name.trim()) {
      const opt = document.createElement('option');
      opt.value = name.trim();
      opt.textContent = name.trim();
      ankiDeckSelect.insertBefore(opt, ankiDeckSelect.lastElementChild);
      ankiDeckSelect.value = name.trim();
      ankiSettings.deckName = name.trim();
      saveAnkiSettings();
    } else {
      ankiDeckSelect.value = ankiSettings.deckName;
    }
  } else {
    ankiSettings.deckName = ankiDeckSelect.value;
    saveAnkiSettings();
  }
  renderAnkiPreview();
});

// Note-type select: fetch fields for the newly chosen model
ankiModelSelect.addEventListener('change', onModelChanged);

// Front/Back field selects
ankiFrontFieldSelect.addEventListener('change', () => {
  ankiSettings.frontFieldName = ankiFrontFieldSelect.value;
  saveAnkiSettings();
  validateSelectedFields();
  renderAnkiPreview();
});
ankiBackFieldSelect.addEventListener('change', () => {
  ankiSettings.backFieldName = ankiBackFieldSelect.value;
  saveAnkiSettings();
  validateSelectedFields();
  renderAnkiPreview();
});

// Preset chips
for (const btn of ankiPresetButtons) {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
}

// Advanced: test connection inline
ankiTestConnectionBtn.addEventListener('click', async () => {
  ankiTestConnectionBtn.disabled = true;
  const originalLabel = ankiTestConnectionBtn.textContent;
  ankiTestConnectionBtn.textContent = 'Testing...';
  ankiTestResult.hidden = true;
  try {
    const version = await ankiConnect('version');
    ankiTestResult.textContent = `Connected. AnkiConnect v${version}`;
    ankiTestResult.className = 'anki-modal-test-result success';
    ankiConnected = true;
    ankiStatusEl.className = 'anki-status-dot connected';
    ankiStatusEl.title = 'AnkiConnect: connected';
    flushPendingFromFrequency();
  } catch (err) {
    ankiTestResult.textContent = 'Could not connect. Make sure Anki is running with AnkiConnect installed.';
    ankiTestResult.className = 'anki-modal-test-result error';
    ankiConnected = false;
    ankiStatusEl.className = 'anki-status-dot disconnected';
    ankiStatusEl.title = 'AnkiConnect: disconnected';
  }
  ankiTestResult.hidden = false;
  ankiTestConnectionBtn.disabled = false;
  ankiTestConnectionBtn.textContent = originalLabel;
  renderConnStatusBanner();
  updateAnkiSelectedCount();
});

// Advanced: reset to defaults
ankiResetDefaultsBtn.addEventListener('click', resetToDefaults);

// Persist card settings whenever any input changes; re-render preview; clear preset.
function bindSettingChange(el, key, getValue) {
  el.addEventListener('change', () => {
    ankiSettings[key] = getValue(el);
    ankiSettings.lastPresetApplied = null;
    saveAnkiSettings();
    updatePresetChipStates();
    renderAnkiPreview();
  });
}
bindSettingChange(ankiIncludeFuriganaInput, 'includeFurigana', el => el.checked);
bindSettingChange(ankiIncludePartOfSpeechInput, 'includePartOfSpeech', el => el.checked);
bindSettingChange(ankiIncludeRomajiInput, 'includeRomaji', el => el.checked);
bindSettingChange(ankiIncludeCountInput, 'includeCount', el => el.checked);
bindSettingChange(ankiAutoTagByTypeInput, 'autoTagByType', el => el.checked);
bindSettingChange(ankiFuriganaFormatSelect, 'furiganaFormat', el => el.value);
bindSettingChange(ankiCustomTagsInput, 'customTags', el => el.value);

// Guide toggle
ankiGuideToggle.addEventListener('click', () => {
  ankiGuideBody.classList.toggle('open');
  ankiGuideChevron.classList.toggle('open');
});

// Stats / Filters collapsible cards
for (const id of ['stats', 'filters']) {
  const header = document.getElementById(`${id}Toggle`);
  const body = document.getElementById(`${id}Body`);
  const chevron = document.getElementById(`${id}Chevron`);
  if (!header || !body || !chevron) continue;
  header.addEventListener('click', () => {
    body.classList.toggle('open');
    chevron.classList.toggle('open');
  });
}

// Copy AnkiConnect addon code
copyAnkiCodeBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  try {
    await navigator.clipboard.writeText('2055492159');
    copyAnkiCodeBtn.textContent = 'Copied!';
    setTimeout(() => { copyAnkiCodeBtn.textContent = 'Copy'; }, 2000);
  } catch {
    copyAnkiCodeBtn.textContent = 'Failed';
    setTimeout(() => { copyAnkiCodeBtn.textContent = 'Copy'; }, 2000);
  }
});

// Test connection from guide
ankiGuideTestBtn.addEventListener('click', async () => {
  ankiGuideTestBtn.disabled = true;
  ankiGuideTestBtn.textContent = 'Testing...';
  ankiGuideTestResult.style.display = 'none';

  const granted = await requestAnkiPermission();
  if (!granted) {
    ankiGuideTestResult.textContent = 'Permission denied. Allow access to http://localhost:8765 to test AnkiConnect.';
    ankiGuideTestResult.className = 'anki-guide-test-result error';
    ankiGuideTestResult.style.display = 'block';
    ankiGuideTestBtn.disabled = false;
    ankiGuideTestBtn.textContent = 'Test Connection Now';
    return;
  }

  try {
    const version = await ankiConnect('version');
    ankiGuideTestResult.textContent = `Connected! AnkiConnect v${version}`;
    ankiGuideTestResult.className = 'anki-guide-test-result success';
    ankiConnected = true;
    ankiStatusEl.className = 'anki-status-dot connected';
    ankiStatusEl.title = 'AnkiConnect: connected';
    flushPendingFromFrequency();
  } catch {
    ankiGuideTestResult.textContent = 'Could not connect. Make sure Anki is running with AnkiConnect installed.';
    ankiGuideTestResult.className = 'anki-guide-test-result error';
    ankiConnected = false;
    ankiStatusEl.className = 'anki-status-dot disconnected';
    ankiStatusEl.title = 'AnkiConnect: disconnected';
  }

  ankiGuideTestResult.style.display = 'block';
  ankiGuideTestBtn.disabled = false;
  ankiGuideTestBtn.textContent = 'Test Connection Now';
  updateAnkiSelectedCount();
});

// Sync Now
ankiSyncNowBtn.addEventListener('click', async () => {
  const deckName = ankiDeckSelect.value;
  if (!deckName || deckName === '__new__') return;

  const total = ankiSelectedWords.size;
  if (total === 0) return;
  console.log('[Anki] Sync Now clicked, deck:', deckName, 'words:', total);

  ankiSettings.deckName = deckName;
  saveAnkiSettings();

  ankiSyncNowBtn.disabled = true;
  ankiSyncCancelBtn.disabled = true;
  ankiProgressContainer.hidden = false;
  ankiSyncResult.hidden = true;
  ankiProgressFill.style.width = '0%';

  let added = 0;
  let skipped = 0;
  let failed = 0;
  const selectedKeys = [...ankiSelectedWords];
  const syncedKeys = [];

  try {
    // Ensure deck exists
    console.log('[Anki] Creating/ensuring deck:', deckName);
    await ankiConnect('createDeck', { deck: deckName });

    for (let i = 0; i < total; i++) {
      const key = selectedKeys[i];
      const [japanese, type] = key.split('|');
      const word = allWords.find(w => w.japanese === japanese && normalizeType(w.type) === type);

      console.log('[Anki] Processing word', i + 1, '/', total, ':', japanese, type);

      if (!word) {
        failed++;
        continue;
      }

      try {
        // Check for duplicates — key on the kanji via the configured front field.
        // Wildcard suffix handles all furigana formats (plain, parentheses, ruby)
        // since all three start with the kanji.
        const frontField = (ankiSettings.frontFieldName || 'Front').trim() || 'Front';
        const existing = await ankiConnect('findNotes', {
          query: `deck:"${deckName}" ${frontField}:${word.japanese}*`
        });

        if (existing && existing.length > 0) {
          console.log('[Anki] Duplicate found, skipping:', japanese);
          skipped++;
          syncedKeys.push(key);
          ankiDeckWords.add(word.japanese);
        } else {
          const note = buildAnkiNote(word, ankiSettings);
          await ankiConnect('addNote', { note });
          console.log('[Anki] Added note:', japanese);
          added++;
          syncedKeys.push(key);
          ankiDeckWords.add(word.japanese);
        }
      } catch (error) {
        console.error('[Anki] Failed to sync word:', japanese, error);
        failed++;
      }

      // Update progress
      ankiProgressFill.style.width = `${((i + 1) / total) * 100}%`;
    }

    // Remove synced words from selection
    for (const key of syncedKeys) {
      ankiSelectedWords.delete(key);
    }
    saveAnkiSelections();
    if (added > 0 || skipped > 0) {
      ankiDeckCacheAt = Date.now();
      saveAnkiDeckWords();
      renderAnkiDeckCacheMeta();
    }
    applyFiltersAndRender();

    console.log('[Anki] Sync complete. Added:', added, 'Skipped:', skipped, 'Failed:', failed);

    // Show result
    const parts = [];
    if (added > 0) parts.push(`${added} added`);
    if (skipped > 0) parts.push(`${skipped} already in Anki`);
    if (failed > 0) parts.push(`${failed} failed`);

    ankiSyncResult.textContent = parts.join(', ') || 'Nothing to sync.';
    ankiSyncResult.className = `anki-sync-result ${failed > 0 && added === 0 ? 'error' : 'success'}`;
    ankiSyncResult.hidden = false;
  } catch (err) {
    ankiSyncResult.textContent = `Sync failed: ${err.message}`;
    ankiSyncResult.className = 'anki-sync-result error';
    ankiSyncResult.hidden = false;
  } finally {
    ankiSyncNowBtn.disabled = ankiSelectedWords.size === 0;
    ankiSyncCancelBtn.disabled = false;
  }
});

// Initialize
init();
