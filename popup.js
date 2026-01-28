const statusEl = document.getElementById('status');
const copyAllBtn = document.getElementById('copyAll');
const copyNewBtn = document.getElementById('copyNew');
const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKey');
const keyStatusEl = document.getElementById('keyStatus');

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

// Load saved key on popup open
loadApiKey();
