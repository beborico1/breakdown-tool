const statusEl = document.getElementById('status');
const copyAllBtn = document.getElementById('copyAll');
const copyNewBtn = document.getElementById('copyNew');
const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKey');
const keyStatusEl = document.getElementById('keyStatus');
const viewAllWordsBtn = document.getElementById('viewAllWords');
const liveTranscribeBtn = document.getElementById('liveTranscribe');
const audioModeToggleBtn = document.getElementById('audioModeToggle');
const tokenCountEl = document.getElementById('tokenCount');
const tokenCostEl = document.getElementById('tokenCost');
const resetUsageBtn = document.getElementById('resetUsage');
const modelSelectEl = document.getElementById('modelSelect');
const modelCostHintEl = document.getElementById('modelCostHint');
const fontSizeSlider = document.getElementById('fontSizeSlider');
const fontSizeValueEl = document.getElementById('fontSizeValue');
const chunkSizeSlider = document.getElementById('chunkSizeSlider');
const chunkSizeValueEl = document.getElementById('chunkSizeValue');

const GEMINI_MODELS = {
  'gemini-2.5-flash':      { label: 'Gemini 2.5 Flash',      costPer1M: 0.15 },
  'gemini-2.5-flash-lite': { label: 'Gemini 2.5 Flash Lite', costPer1M: 0.075 },
  'gemini-2.5-pro':        { label: 'Gemini 2.5 Pro',        costPer1M: 1.25 },
  'gemini-2.0-flash':      { label: 'Gemini 2.0 Flash',      costPer1M: 0.10 },
  'gemini-2.0-flash-lite': { label: 'Gemini 2.0 Flash Lite', costPer1M: 0.075 },
};

const DEFAULT_MODEL = 'gemini-2.5-flash';
let currentModelId = DEFAULT_MODEL;

/* Commented out - Minimalistic Mode and Word Frequency stats removed
const minimalisticToggle = document.getElementById('minimalisticToggle');
const uniqueWordsEl = document.getElementById('uniqueWords');
const totalWordsEl = document.getElementById('totalWords');
const topWordsEl = document.getElementById('topWords');
const clearDataBtn = document.getElementById('clearData');
*/

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

/* Commented out - Minimalistic Mode functions removed
/**
 * Load minimalistic mode setting
 */
/*
async function loadMinimalisticMode() {
  chrome.storage.sync.get(['minimalisticModeEnabled'], (result) => {
    minimalisticToggle.checked = result.minimalisticModeEnabled || false;
  });
}
*/

/**
 * Save minimalistic mode setting
 */
/*
function saveMinimalisticMode() {
  const enabled = minimalisticToggle.checked;
  chrome.storage.sync.set({ minimalisticModeEnabled: enabled });
}

// Handle minimalistic mode toggle
minimalisticToggle.addEventListener('change', saveMinimalisticMode);
*/

/* Commented out - Word Frequency stats functions removed
/**
 * Load word frequency stats from storage
 */
/*
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
*/

/**
 * Clear all frequency data
 */
/*
async function clearFrequencyData() {
  if (!confirm('Are you sure you want to clear all word frequency data? This cannot be undone.')) {
    return;
  }

  chrome.storage.local.remove(['wordFrequencyData'], () => {
    loadFrequencyStats();
    showStatus('Word frequency data cleared', true);
  });
}
*/

/**
 * Open the full frequency analytics page
 */
function openFrequencyPage() {
  chrome.tabs.create({ url: 'src/pages/frequency/frequency.html' });
}

// Audio Mode toggle
audioModeToggleBtn.addEventListener('click', async () => {
  // Check API key first
  const result = await new Promise(resolve =>
    chrome.storage.sync.get(['geminiApiKey'], resolve)
  );
  if (!result.geminiApiKey) {
    showStatus('Set a Gemini API key first', false);
    return;
  }

  // Check current state
  const state = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'get-audio-mode-state' }, resolve)
  );

  if (state?.active) {
    // Stop
    audioModeToggleBtn.disabled = true;
    audioModeToggleBtn.textContent = 'Stopping...';
    const response = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'stop-audio-capture' }, resolve)
    );
    audioModeToggleBtn.disabled = false;
    if (response?.success) {
      setAudioButtonState(false);
    } else {
      showStatus('Failed to stop: ' + (response?.error || 'Unknown error'), false);
    }
  } else {
    // Start - get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      showStatus('No active tab found', false);
      return;
    }

    audioModeToggleBtn.disabled = true;
    audioModeToggleBtn.textContent = 'Starting...';
    const response = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'start-audio-capture', tabId: tab.id }, resolve)
    );
    audioModeToggleBtn.disabled = false;
    if (response?.success) {
      setAudioButtonState(true);
    } else {
      showStatus('Failed to start: ' + (response?.error || 'Unknown error'), false);
    }
  }
});

/**
 * Set the audio mode button state
 */
function setAudioButtonState(active) {
  if (active) {
    audioModeToggleBtn.textContent = 'Stop Listening';
    audioModeToggleBtn.className = 'btn btn-danger-audio';
  } else {
    audioModeToggleBtn.textContent = 'Start Listening';
    audioModeToggleBtn.className = 'btn btn-primary';
  }
}

/**
 * Load audio mode state on popup open
 */
function loadAudioModeState() {
  chrome.runtime.sendMessage({ type: 'get-audio-mode-state' }, (state) => {
    if (state?.active) {
      setAudioButtonState(true);
    }
  });
}

// Transcription page
liveTranscribeBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'src/pages/transcribe/transcribe.html' });
});

// Frequency section event listeners
viewAllWordsBtn.addEventListener('click', openFrequencyPage);
// clearDataBtn.addEventListener('click', clearFrequencyData);

/**
 * Initialize popup - check if on Google Meet
 */
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isOnMeet = tab?.url?.includes('meet.google.com');

  const buttonsDiv = document.querySelector('.buttons');
  buttonsDiv.style.display = isOnMeet ? 'flex' : 'none';
}

/**
 * Format token count for display (e.g., 1234 -> "1,234", 1234567 -> "1.2M")
 * @param {number} tokens
 * @returns {string}
 */
function formatTokenCount(tokens) {
  if (tokens >= 1000000) {
    return (tokens / 1000000).toFixed(1) + 'M';
  }
  if (tokens >= 10000) {
    return (tokens / 1000).toFixed(1) + 'K';
  }
  return tokens.toLocaleString();
}

/**
 * Format cost based on token count and selected model
 * @param {number} tokens
 * @returns {string}
 */
function formatCost(tokens) {
  const costPer1M = GEMINI_MODELS[currentModelId]?.costPer1M || 0.15;
  const cost = (tokens / 1000000) * costPer1M;
  if (cost < 0.01) {
    return '~$' + cost.toFixed(4);
  }
  return '~$' + cost.toFixed(2);
}

/**
 * Update the usage display with optional animation
 * @param {number} tokens
 * @param {boolean} animate
 */
function updateUsageDisplay(tokens, animate = false) {
  tokenCountEl.textContent = formatTokenCount(tokens);
  tokenCostEl.textContent = formatCost(tokens);

  // Disable reset button if zero tokens
  resetUsageBtn.disabled = tokens === 0;

  if (animate) {
    tokenCountEl.classList.add('updating');
    tokenCostEl.classList.add('updating');
    setTimeout(() => {
      tokenCountEl.classList.remove('updating');
      tokenCostEl.classList.remove('updating');
    }, 300);
  }
}

/**
 * Load token usage from storage
 */
function loadUsage() {
  chrome.storage.local.get(['tokenUsage'], (result) => {
    const tokens = result.tokenUsage || 0;
    updateUsageDisplay(tokens);
  });
}

/**
 * Reset token usage counter
 */
function resetUsage() {
  if (!confirm('Reset token usage counter to zero?')) {
    return;
  }

  chrome.storage.local.set({ tokenUsage: 0 }, () => {
    updateUsageDisplay(0, true);
    showStatus('Token usage reset', true);
  });
}

/**
 * Update the cost hint text with the selected model info
 * @param {string} modelId
 */
function updateCostHint(modelId) {
  const model = GEMINI_MODELS[modelId];
  if (model) {
    modelCostHintEl.textContent = `Uses ${model.label} (~$${model.costPer1M}/1M tokens)`;
  }
}

/**
 * Load saved model from storage
 */
function loadModel() {
  chrome.storage.sync.get(['geminiModel'], (result) => {
    currentModelId = result.geminiModel || DEFAULT_MODEL;
    modelSelectEl.value = currentModelId;
    updateCostHint(currentModelId);
    loadUsage(); // re-render cost with correct model rate
  });
}

// Handle model selection change
modelSelectEl.addEventListener('change', () => {
  const modelId = modelSelectEl.value;
  currentModelId = modelId;
  chrome.storage.sync.set({ geminiModel: modelId });
  updateCostHint(modelId);
  loadUsage(); // re-render cost with new model rate
});

// Listen for storage changes to update in real-time
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.tokenUsage) {
    updateUsageDisplay(changes.tokenUsage.newValue || 0, true);
  }
  if (areaName === 'sync' && changes.geminiModel) {
    currentModelId = changes.geminiModel.newValue || DEFAULT_MODEL;
    modelSelectEl.value = currentModelId;
    updateCostHint(currentModelId);
    loadUsage();
  }
  if (areaName === 'sync' && changes.sentenceChunkSize) {
    const size = changes.sentenceChunkSize.newValue || 2;
    chunkSizeSlider.value = size;
    chunkSizeValueEl.textContent = size;
  }
});

// Reset usage button handler
resetUsageBtn.addEventListener('click', resetUsage);

/**
 * Load font size setting from storage
 */
function loadFontSize() {
  chrome.storage.sync.get(['wordBlockFontSize'], (result) => {
    const size = result.wordBlockFontSize || 15;
    fontSizeSlider.value = size;
    fontSizeValueEl.textContent = `${size}px`;
  });
}

// Font size slider handler
fontSizeSlider.addEventListener('input', () => {
  const size = parseInt(fontSizeSlider.value, 10);
  fontSizeValueEl.textContent = `${size}px`;
  chrome.storage.sync.set({ wordBlockFontSize: size });
});

/**
 * Load sentence chunk size setting from storage
 */
function loadChunkSize() {
  chrome.storage.sync.get(['sentenceChunkSize'], (result) => {
    const size = result.sentenceChunkSize || 2;
    chunkSizeSlider.value = size;
    chunkSizeValueEl.textContent = size;
  });
}

// Chunk size slider handler
chunkSizeSlider.addEventListener('input', () => {
  const size = parseInt(chunkSizeSlider.value, 10);
  chunkSizeValueEl.textContent = size;
  chrome.storage.sync.set({ sentenceChunkSize: size });
});

// Load saved key and model on popup open
loadApiKey();
loadModel();
loadFontSize();
loadChunkSize();
loadAudioModeState();
// loadMinimalisticMode();
// loadFrequencyStats();

// Initialize popup state
init();
