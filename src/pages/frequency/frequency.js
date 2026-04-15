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
const ankiSettingsPanel = document.getElementById('ankiSettingsPanel');
const ankiDeckSelect = document.getElementById('ankiDeckSelect');
const ankiSyncNowBtn = document.getElementById('ankiSyncNow');
const ankiSyncCancelBtn = document.getElementById('ankiSyncCancel');
const ankiProgressContainer = document.getElementById('ankiProgressContainer');
const ankiProgressFill = document.getElementById('ankiProgressFill');
const ankiSyncResult = document.getElementById('ankiSyncResult');
const ankiCardSettingsToggle = document.getElementById('ankiCardSettingsToggle');
const ankiCardSettingsBody = document.getElementById('ankiCardSettingsBody');
const ankiCardSettingsChevron = document.getElementById('ankiCardSettingsChevron');
const ankiIncludeFuriganaInput = document.getElementById('ankiIncludeFurigana');
const ankiIncludePartOfSpeechInput = document.getElementById('ankiIncludePartOfSpeech');
const ankiIncludeRomajiInput = document.getElementById('ankiIncludeRomaji');
const ankiIncludeCountInput = document.getElementById('ankiIncludeCount');
const ankiFuriganaFormatSelect = document.getElementById('ankiFuriganaFormat');
const ankiModelNameInput = document.getElementById('ankiModelName');
const ankiFrontFieldInput = document.getElementById('ankiFrontField');
const ankiBackFieldInput = document.getElementById('ankiBackField');
const ankiCustomTagsInput = document.getElementById('ankiCustomTags');
const ankiAutoTagByTypeInput = document.getElementById('ankiAutoTagByType');

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
  autoTagByType: true
};
let ankiSettings = { ...DEFAULT_ANKI_SETTINGS };

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
  console.log('[Anki] Updated count:', ankiSelectedWords.size, 'button disabled:', syncToAnkiBtn.disabled);
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

/**
 * Populate the card-settings inputs from the current ankiSettings object.
 */
function hydrateAnkiSettingsInputs() {
  ankiIncludeFuriganaInput.checked = ankiSettings.includeFurigana;
  ankiIncludePartOfSpeechInput.checked = ankiSettings.includePartOfSpeech;
  ankiIncludeRomajiInput.checked = ankiSettings.includeRomaji;
  ankiIncludeCountInput.checked = ankiSettings.includeCount;
  ankiFuriganaFormatSelect.value = ankiSettings.furiganaFormat;
  ankiModelNameInput.value = ankiSettings.modelName;
  ankiFrontFieldInput.value = ankiSettings.frontFieldName;
  ankiBackFieldInput.value = ankiSettings.backFieldName;
  ankiCustomTagsInput.value = ankiSettings.customTags;
  ankiAutoTagByTypeInput.checked = ankiSettings.autoTagByType;
}

// Sync to Anki button -> show settings panel and populate decks
syncToAnkiBtn.addEventListener('click', async () => {
  console.log('[Anki] Sync button clicked, opening settings panel');

  const granted = await requestAnkiPermission();
  if (!granted) {
    alert('Anki sync needs permission to talk to AnkiConnect on http://localhost:8765. ' +
      'Click "Sync to Anki" again and choose "Allow" to enable it.');
    return;
  }

  ankiSettingsPanel.style.display = 'block';
  ankiSyncResult.style.display = 'none';
  ankiProgressContainer.style.display = 'none';
  ankiProgressFill.style.width = '0%';

  hydrateAnkiSettingsInputs();

  // Re-check connection when panel opens
  await checkAnkiConnection();

  try {
    const decks = await ankiConnect('deckNames');
    console.log('[Anki] Fetched decks:', decks);
    ankiDeckSelect.innerHTML = '';
    for (const deck of decks) {
      const opt = document.createElement('option');
      opt.value = deck;
      opt.textContent = deck;
      if (deck === ankiSettings.deckName) opt.selected = true;
      ankiDeckSelect.appendChild(opt);
    }
    // Add option to create new
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ Create new deck...';
    ankiDeckSelect.appendChild(newOpt);
  } catch (error) {
    console.error('[Anki] Failed to fetch decks:', error);
    ankiDeckSelect.innerHTML = '<option value="Kaigi Meeting">Kaigi Meeting</option>';
  }
});

ankiDeckSelect.addEventListener('change', () => {
  if (ankiDeckSelect.value === '__new__') {
    const name = prompt('Enter new deck name:');
    if (name && name.trim()) {
      const opt = document.createElement('option');
      opt.value = name.trim();
      opt.textContent = name.trim();
      ankiDeckSelect.insertBefore(opt, ankiDeckSelect.lastElementChild);
      ankiDeckSelect.value = name.trim();
    } else {
      ankiDeckSelect.value = ankiSettings.deckName;
    }
  }
});

// Card settings collapse toggle
ankiCardSettingsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = ankiCardSettingsBody.classList.toggle('open');
  ankiCardSettingsChevron.classList.toggle('open', isOpen);
});

// Persist card settings whenever any input changes
function bindSettingChange(el, key, getValue) {
  el.addEventListener('change', () => {
    ankiSettings[key] = getValue(el);
    saveAnkiSettings();
  });
}
bindSettingChange(ankiIncludeFuriganaInput, 'includeFurigana', el => el.checked);
bindSettingChange(ankiIncludePartOfSpeechInput, 'includePartOfSpeech', el => el.checked);
bindSettingChange(ankiIncludeRomajiInput, 'includeRomaji', el => el.checked);
bindSettingChange(ankiIncludeCountInput, 'includeCount', el => el.checked);
bindSettingChange(ankiAutoTagByTypeInput, 'autoTagByType', el => el.checked);
bindSettingChange(ankiFuriganaFormatSelect, 'furiganaFormat', el => el.value);
bindSettingChange(ankiModelNameInput, 'modelName', el => el.value.trim() || 'Basic');
bindSettingChange(ankiFrontFieldInput, 'frontFieldName', el => el.value.trim() || 'Front');
bindSettingChange(ankiBackFieldInput, 'backFieldName', el => el.value.trim() || 'Back');
bindSettingChange(ankiCustomTagsInput, 'customTags', el => el.value);

ankiSyncCancelBtn.addEventListener('click', () => {
  ankiSettingsPanel.style.display = 'none';
});

// Close settings panel when clicking outside
document.addEventListener('click', (e) => {
  if (ankiSettingsPanel.style.display === 'none') return;
  const wrapper = document.querySelector('.anki-sync-wrapper');
  if (!wrapper.contains(e.target)) {
    ankiSettingsPanel.style.display = 'none';
  }
});

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
  console.log('[Anki] Sync Now clicked, deck:', deckName, 'words:', total);

  ankiSettings.deckName = deckName;
  saveAnkiSettings();

  ankiSyncNowBtn.disabled = true;
  ankiSyncCancelBtn.disabled = true;
  ankiProgressContainer.style.display = 'block';
  ankiSyncResult.style.display = 'none';
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

    ankiSyncResult.textContent = parts.join(', ');
    ankiSyncResult.className = `anki-sync-result ${failed > 0 && added === 0 ? 'error' : 'success'}`;
    ankiSyncResult.style.display = 'block';
  } catch (err) {
    ankiSyncResult.textContent = `Sync failed: ${err.message}`;
    ankiSyncResult.className = 'anki-sync-result error';
    ankiSyncResult.style.display = 'block';
  } finally {
    ankiSyncNowBtn.disabled = false;
    ankiSyncCancelBtn.disabled = false;
  }
});

// Initialize
init();
