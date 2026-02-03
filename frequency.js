// DOM Elements
const totalWordsEl = document.getElementById('totalWordsValue');
const uniqueWordsEl = document.getElementById('uniqueWordsValue');
const daysTrackingEl = document.getElementById('daysTrackingValue');
const typeChartEl = document.getElementById('typeChart');
const wordGridEl = document.getElementById('wordGrid');
const emptyStateEl = document.getElementById('emptyState');
const loadingStateEl = document.getElementById('loadingState');
const searchInput = document.getElementById('searchInput');
const sortBySelect = document.getElementById('sortBy');
const exportJsonBtn = document.getElementById('exportJson');
const exportCsvBtn = document.getElementById('exportCsv');

// State
let allWords = [];
let filteredWords = [];
let currentFilter = 'all';
let currentSort = 'frequency';
let searchQuery = '';

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

    return `
      <div class="word-card">
        <div class="word-card-header">
          <span class="word-japanese ${type}">${japanese}</span>
          <span class="word-count">${word.count}x</span>
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
  const data = await loadData();

  loadingStateEl.style.display = 'none';

  if (!data || !data.words || Object.keys(data.words).length === 0) {
    totalWordsEl.textContent = '0';
    uniqueWordsEl.textContent = '0';
    daysTrackingEl.textContent = '0';
    emptyStateEl.style.display = 'block';
    wordGridEl.style.display = 'none';
    typeChartEl.innerHTML = '<p style="color: #6B7280; text-align: center;">No data yet</p>';
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

// Initialize
init();
