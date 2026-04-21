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
let currentFilter = 'all';
let currentSort = 'frequency';
let searchQuery = '';

// Anki State
let ankiSelectedWords = new Set();
let ankiConnected = false;

// Ignored words state (keys hidden from the word grid)
let ignoredWords = new Set();

const DEFAULT_ANKI_SETTINGS = {
  deckName: 'Kaigi Meeting',
  includeFurigana: true,
  includePartOfSpeech: true,
  includeRomaji: true,
  includeCount: false,
  furiganaFormat: 'parentheses',
  modelName: 'Basic',
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
 * Load data from chrome.storage.local
 */
async function loadData() {
  return new Promise(resolve => {
    chrome.storage.local.get(['wordFrequencyData'], (result) => {
      resolve(result.wordFrequencyData || null);
    });
  });
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
 * Load Anki settings from chrome.storage.sync
 */
async function loadAnkiSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(['ankiSettings'], (result) => {
      ankiSettings = { ...DEFAULT_ANKI_SETTINGS, ...(result.ankiSettings || {}) };
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

    return `
      <div class="word-card${isSelected ? ' anki-selected' : ''}">
        <div class="word-card-header">
          <span class="word-japanese ${type}">${japanese}</span>
          <div class="word-card-actions">
            <span class="word-count">${word.count}x</span>
            <label class="anki-checkbox">
              <input type="checkbox" class="anki-check-input" data-word-key="${escapeHtml(wordKey)}" ${isSelected ? 'checked' : ''}>
            </label>
          </div>
        </div>
        <div class="word-reading">${romaji}</div>
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
  let result = filterWords(allWords, currentFilter);
  result = result.filter(w => !ignoredWords.has(`${w.japanese}|${normalizeType(w.type)}`));
  result = searchWords(result, searchQuery);
  result = sortWords(result, currentSort);
  filteredWords = result;
  renderWordGrid(result);
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
    loadAnkiSettings()
  ]);

  console.log('[Anki] Loaded selections:', ankiSelectedWords.size, 'words');
  console.log('[Anki] Loaded settings, deck:', ankiSettings.deckName);

  // Check Anki connection (fire-and-forget)
  checkAnkiConnection();

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
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.type;
    applyFiltersAndRender();
  });
});

sortBySelect.addEventListener('change', () => {
  currentSort = sortBySelect.value;
  applyFiltersAndRender();
});

let searchTimeout;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchQuery = searchInput.value.trim();
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
        } else {
          const note = buildAnkiNote(word, ankiSettings);
          await ankiConnect('addNote', { note });
          console.log('[Anki] Added note:', japanese);
          added++;
          syncedKeys.push(key);
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
