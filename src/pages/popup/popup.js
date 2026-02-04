const statusEl = document.getElementById('status');
const copyAllBtn = document.getElementById('copyAll');
const copyNewBtn = document.getElementById('copyNew');
const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKey');
const keyStatusEl = document.getElementById('keyStatus');
const minimalisticToggle = document.getElementById('minimalisticToggle');
const uniqueWordsEl = document.getElementById('uniqueWords');
const totalWordsEl = document.getElementById('totalWords');
const topWordsEl = document.getElementById('topWords');
const viewAllWordsBtn = document.getElementById('viewAllWords');
const clearDataBtn = document.getElementById('clearData');

/**
 * Show status message
 * @param {string} message
 * @param {boolean} isSuccess
 */
function showStatus(message, isSuccess) {
  statusEl.textContent = message;
  statusEl.className = `status ${isSuccess ? 'success' : 'error'}`;
  statusEl.style.display = 'block';

  // Auto-hide after 3 seconds
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, 3000);
}

/**
 * Show key status message
 * @param {string} message
 * @param {boolean} isSuccess
 */
function showKeyStatus(message, isSuccess) {
  keyStatusEl.textContent = message;
  keyStatusEl.className = `key-status ${isSuccess ? 'success' : 'error'}`;
  keyStatusEl.style.display = 'block';

  setTimeout(() => {
    keyStatusEl.style.display = 'none';
  }, 3000);
}

/**
 * Load saved API key
 */
async function loadApiKey() {
  chrome.storage.sync.get(['geminiApiKey'], (result) => {
    if (result.geminiApiKey) {
      // Show masked key
      apiKeyInput.value = '••••••••••••••••';
      apiKeyInput.dataset.hasKey = 'true';
    }
  });
}

/**
 * Save API key
 */
async function saveApiKey() {
  const key = apiKeyInput.value.trim();

  // Don't save if it's the masked placeholder
  if (key === '••••••••••••••••' || key === '') {
    showKeyStatus('Enter a valid API key', false);
    return;
  }

  chrome.storage.sync.set({ geminiApiKey: key }, () => {
    showKeyStatus('API key saved', true);
    apiKeyInput.value = '••••••••••••••••';
    apiKeyInput.dataset.hasKey = 'true';
  });
}

/**
 * Send message to content script and copy result to clipboard
 * @param {string} action
 */
async function sendAction(action) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url?.includes('meet.google.com')) {
      showStatus('Please open a Google Meet first', false);
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action }, async (response) => {
      if (chrome.runtime.lastError) {
        showStatus('Error: Refresh the Meet page and try again', false);
        return;
      }

      if (response) {
        if (response.success && response.text) {
          // Copy to clipboard from popup (which has focus)
          try {
            await navigator.clipboard.writeText(response.text);
            showStatus(response.message, true);
          } catch (err) {
            showStatus('Failed to copy to clipboard', false);
          }
        } else {
          showStatus(response.message, response.success);
        }
      }
    });
  } catch (err) {
    showStatus('Error: ' + err.message, false);
  }
}

// Clear the masked value when user focuses the input
apiKeyInput.addEventListener('focus', () => {
  if (apiKeyInput.dataset.hasKey === 'true') {
    apiKeyInput.value = '';
  }
});

// Restore masked value if user leaves without entering anything
apiKeyInput.addEventListener('blur', () => {
  if (apiKeyInput.dataset.hasKey === 'true' && apiKeyInput.value === '') {
    apiKeyInput.value = '••••••••••••••••';
  }
});

copyAllBtn.addEventListener('click', () => sendAction('copyAll'));
copyNewBtn.addEventListener('click', () => sendAction('copyNew'));
saveKeyBtn.addEventListener('click', saveApiKey);

// Allow Enter key to save
apiKeyInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    saveApiKey();
  }
});

/**
 * Load minimalistic mode setting
 */
async function loadMinimalisticMode() {
  chrome.storage.sync.get(['minimalisticModeEnabled'], (result) => {
    minimalisticToggle.checked = result.minimalisticModeEnabled || false;
  });
}

/**
 * Save minimalistic mode setting
 */
function saveMinimalisticMode() {
  const enabled = minimalisticToggle.checked;
  chrome.storage.sync.set({ minimalisticModeEnabled: enabled });
}

// Handle minimalistic mode toggle
minimalisticToggle.addEventListener('change', saveMinimalisticMode);

/**
 * Load word frequency stats from storage
 */
async function loadFrequencyStats() {
  chrome.storage.local.get(['wordFrequencyData'], (result) => {
    const data = result.wordFrequencyData;

    if (!data || data.uniqueWords === 0) {
      uniqueWordsEl.textContent = '0 unique';
      totalWordsEl.textContent = '0 total';
      topWordsEl.innerHTML = '<span class="top-words-empty">No words tracked yet</span>';
      return;
    }

    uniqueWordsEl.textContent = `${data.uniqueWords.toLocaleString()} unique`;
    totalWordsEl.textContent = `${data.totalWords.toLocaleString()} total`;

    // Get top 3 words by count
    const sortedWords = Object.values(data.words)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    if (sortedWords.length > 0) {
      topWordsEl.innerHTML = sortedWords
        .map(w => `<span class="top-word"><span class="top-word-text">${w.japanese}</span><span class="top-word-count">(${w.count})</span></span>`)
        .join(' ');
    } else {
      topWordsEl.innerHTML = '<span class="top-words-empty">No words tracked yet</span>';
    }
  });
}

/**
 * Clear all frequency data
 */
async function clearFrequencyData() {
  if (!confirm('Are you sure you want to clear all word frequency data? This cannot be undone.')) {
    return;
  }

  chrome.storage.local.remove(['wordFrequencyData'], () => {
    loadFrequencyStats();
    showStatus('Word frequency data cleared', true);
  });
}

/**
 * Open the full frequency analytics page
 */
function openFrequencyPage() {
  chrome.tabs.create({ url: 'src/pages/frequency/frequency.html' });
}

// Frequency section event listeners
viewAllWordsBtn.addEventListener('click', openFrequencyPage);
clearDataBtn.addEventListener('click', clearFrequencyData);

// Load saved key on popup open
loadApiKey();
loadMinimalisticMode();
loadFrequencyStats();
