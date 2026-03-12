/**
 * Service Worker for Japanese Audio Mode
 * Manages tab audio capture, offscreen document, and content script injection.
 */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

/**
 * Check if an offscreen document already exists
 */
async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

/**
 * Create the offscreen document if it doesn't exist
 */
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio for Japanese transcription'
  });
}

/**
 * Remove the offscreen document
 */
async function removeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

/**
 * Start audio capture for the given tab
 */
async function startAudioCapture(tabId) {
  try {
    // Get the media stream ID for the tab
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

    // Create offscreen document
    await ensureOffscreenDocument();

    // Send stream ID to offscreen document
    chrome.runtime.sendMessage({
      type: 'offscreen-start-capture',
      streamId,
      tabId
    });

    // Inject the audio content script and CSS into the tab
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['src/content/content.css']
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['dist/audio-content.js']
    });

    // Store state
    await chrome.storage.session.set({
      audioMode: { active: true, tabId }
    });

    return { success: true };
  } catch (error) {
    console.error('[AudioMode] Start failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Stop audio capture
 */
async function stopAudioCapture() {
  try {
    const { audioMode } = await chrome.storage.session.get('audioMode');
    const tabId = audioMode?.tabId;

    // Tell offscreen to stop
    chrome.runtime.sendMessage({ type: 'offscreen-stop-capture' });

    // Tell content script to remove panel
    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'audio-mode-stopped' });
      } catch (e) {
        // Tab may have been closed
      }
    }

    // Clean up offscreen document
    await removeOffscreenDocument();

    // Clear state
    await chrome.storage.session.set({
      audioMode: { active: false, tabId: null }
    });

    return { success: true };
  } catch (error) {
    console.error('[AudioMode] Stop failed:', error);
    return { success: false, error: error.message };
  }
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'start-audio-capture') {
    startAudioCapture(message.tabId).then(sendResponse);
    return true; // async response
  }

  if (message.type === 'stop-audio-capture') {
    stopAudioCapture().then(sendResponse);
    return true;
  }

  if (message.type === 'audio-segment') {
    // Relay audio segment from offscreen → content script
    chrome.storage.session.get('audioMode', ({ audioMode }) => {
      if (audioMode?.tabId) {
        chrome.tabs.sendMessage(audioMode.tabId, {
          type: 'audio-segment',
          audio: message.audio,
          mimeType: message.mimeType
        }).catch(() => {
          // Tab may have been closed, stop capture
          stopAudioCapture();
        });
      }
    });
    return false;
  }

  if (message.type === 'get-audio-mode-state') {
    chrome.storage.session.get('audioMode', ({ audioMode }) => {
      sendResponse(audioMode || { active: false, tabId: null });
    });
    return true;
  }
});

// Clean up when the captured tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { audioMode } = await chrome.storage.session.get('audioMode');
  if (audioMode?.active && audioMode.tabId === tabId) {
    stopAudioCapture();
  }
});
