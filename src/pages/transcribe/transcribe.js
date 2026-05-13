// ============================================
// Live Japanese Transcription Page
// Uses MediaRecorder + Gemini audio API for transcription + analysis
// ============================================

import { initDisplayPreferences } from '../../content/core/display-preferences.js';
import { paintWordColoring } from '../../content/shared/word-render.js';
import { attachHoverListeners } from '../../content/meet/hover-card.js';

initDisplayPreferences();

// --- DOM refs ---
const micBtn = document.getElementById('micBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statusRow = document.getElementById('statusRow');
const warningNoKey = document.getElementById('warningNoKey');
const warningNoMic = document.getElementById('warningNoMic');
const silenceSlider = document.getElementById('silenceSlider');
const silenceValue = document.getElementById('silenceValue');
const maxDurationSlider = document.getElementById('maxDurationSlider');
const maxDurationValue = document.getElementById('maxDurationValue');
const sensitivitySlider = document.getElementById('sensitivitySlider');
const sensitivityValue = document.getElementById('sensitivityValue');
const minDurationSlider = document.getElementById('minDurationSlider');
const minDurationValue = document.getElementById('minDurationValue');
const analyzeNowBtn = document.getElementById('analyzeNow');
const audioLevelBar = document.getElementById('audioLevelBar');
const segmentTimerEl = document.getElementById('segmentTimer');
const segmentsProcessedEl = document.getElementById('segmentsProcessed');
const wordsAnalyzedEl = document.getElementById('wordsAnalyzed');
const historyContainer = document.getElementById('historyContainer');
const historyEmpty = document.getElementById('historyEmpty');
const historyActions = document.getElementById('historyActions');
const settingsBtn = document.getElementById('settingsBtn');
const silenceControls = document.getElementById('silenceControls');
if (settingsBtn && silenceControls) {
  settingsBtn.addEventListener('click', () => {
    const collapsed = silenceControls.classList.toggle('collapsed');
    settingsBtn.classList.toggle('active', !collapsed);
    settingsBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
}

// --- API base ---
const LOCAL_API_BASE = 'http://127.0.0.1:8787';
const CLOUD_API_BASE = 'https://generativelanguage.googleapis.com';

async function getApiBase() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['apiSource'], (result) => {
      resolve(result.apiSource === 'local' ? LOCAL_API_BASE : CLOUD_API_BASE);
    });
  });
}

async function resolveAuth() {
  const apiBase = await getApiBase();
  const isLocal = apiBase === LOCAL_API_BASE;
  const key = (await getApiKey()) || (isLocal ? 'local' : null);
  if (!key) throw new Error('No API key. Set it in the extension popup.');
  return { apiBase, apiKey: key };
}

// --- State ---
let apiKey = null;
let modelId = 'gemini-2.5-flash-lite';
let isListening = false;
let silenceThreshold = 3000; // ms
let segmentCount = 0;
let wordCount = 0;
let accumulatedTranscript = ''; // transcribed text for "Analyze Now" re-analysis

// --- Audio capture state ---
let mediaStream = null;
let audioContext = null;
let analyser = null;
let mediaRecorder = null;
let recordedChunks = [];
let silenceStart = null;
let segmentStart = null;
let silenceCheckInterval = null;
let currentRMS = 0;
let speechSamples = 0;
let totalSamples = 0;

let SILENCE_RMS_THRESHOLD = 15;   // 0-255 scale
let MIN_SEGMENT_DURATION = 500;   // ms
let MAX_SEGMENT_DURATION = 15000; // ms
const MIN_SPEECH_RATIO = 0.10;    // Skip transcription if < 10% of samples had speech

// ============================================
// Duplicated utilities (from api.js, text.js, frequency-tracker.js)
// ============================================

async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['geminiApiKey'], (result) => {
      resolve(result.geminiApiKey || null);
    });
  });
}

async function getModel() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['geminiModel'], (result) => {
      resolve(result.geminiModel || 'gemini-2.5-flash-lite');
    });
  });
}

function updateTokenUsage(tokens) {
  if (!tokens || tokens <= 0) return;
  chrome.storage.local.get(['tokenUsage'], (result) => {
    const currentUsage = result.tokenUsage || 0;
    chrome.storage.local.set({ tokenUsage: currentUsage + tokens });
  });
}

function splitJapaneseText(text, maxChars = 30) {
  const chunks = [];
  const separators = /([。、！？\n])/g;
  let current = '';
  const parts = text.split(separators);

  for (const part of parts) {
    if ((current + part).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = part;
    } else {
      current += part;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  if (chunks.length === 0 && text.length > 0) {
    for (let i = 0; i < text.length; i += maxChars) {
      chunks.push(text.slice(i, i + maxChars).trim());
    }
  }
  return chunks.filter(c => c.length > 0);
}

function getWordTypeClass(type) {
  const typeMap = {
    'noun': 'noun', 'verb': 'verb', 'particle': 'particle',
    'adjective': 'adjective', 'adverb': 'adverb', 'counter': 'counter',
    'expression': 'expression', 'auxiliary': 'auxiliary', 'copula': 'copula'
  };
  return typeMap[type?.toLowerCase()] || 'other';
}

async function analyzeJapaneseChunked(text) {
  const chunks = splitJapaneseText(text, 30);
  const allWords = [];
  let fullTranslation = '';

  for (const chunk of chunks) {
    try {
      const result = await analyzeJapaneseWithGemini(chunk, { noRetry: true });
      if (!result.truncated) {
        allWords.push(...result.words);
        fullTranslation += result.translation + ' ';
      } else {
        allWords.push({ japanese: chunk, reading: '', romaji: chunk, english: '[truncated]', type: 'expression' });
      }
    } catch (error) {
      allWords.push({ japanese: chunk, reading: '', romaji: chunk, english: '[error]', type: 'expression' });
    }
  }

  return { original: text, translation: fullTranslation.trim(), words: allWords };
}

async function analyzeJapaneseWithGemini(text, options = {}) {
  const { apiBase, apiKey: resolvedKey } = await resolveAuth();

  const prompt = `Analyze this Japanese text and return ONLY valid JSON (no markdown, no code blocks, no explanation):
{
  "original": "the original Japanese text exactly as provided",
  "translation": "natural English translation of the full sentence",
  "words": [
    {
      "japanese": "word in kanji/kana as it appears",
      "reading": "hiragana reading (only for words with kanji, empty string for hiragana/katakana-only words)",
      "romaji": "romanized pronunciation",
      "english": "English meaning or grammatical function",
      "type": "noun|verb|particle|adjective|adverb|counter|expression|auxiliary|copula"
    }
  ]
}

Important:
- Break down ALL words including particles (は, が, を, に, etc.)
- For particles, use their grammatical function as english (e.g., "topic marker", "subject marker", "object marker")
- Keep word order matching the original sentence
- Use lowercase for romaji except for proper nouns
- For verbs, include the conjugated form as it appears

Text: ${text}`;

  const response = await fetch(
    `${apiBase}/v1beta/models/${modelId}:generateContent?key=${resolvedKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 65536,
          responseMimeType: 'application/json',
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Analysis failed');
  }

  const data = await response.json();
  const finishReason = data.candidates?.[0]?.finishReason;
  let responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  const usageMetadata = data.usageMetadata;
  if (usageMetadata?.totalTokenCount) {
    updateTokenUsage(usageMetadata.totalTokenCount);
  }

  if (!responseText) throw new Error('No analysis returned');

  if (finishReason === 'MAX_TOKENS') {
    if (!options?.noRetry) return analyzeJapaneseChunked(text);
    return { truncated: true, original: text };
  }

  responseText = responseText.trim();
  if (responseText.startsWith('```json')) responseText = responseText.slice(7);
  else if (responseText.startsWith('```')) responseText = responseText.slice(3);
  if (responseText.endsWith('```')) responseText = responseText.slice(0, -3);
  responseText = responseText.trim();

  try {
    const breakdown = JSON.parse(responseText);
    if (!breakdown.original || !breakdown.translation || !Array.isArray(breakdown.words)) {
      throw new Error('Invalid breakdown structure');
    }
    return breakdown;
  } catch (parseError) {
    if (!options?.noRetry && parseError instanceof SyntaxError) {
      return analyzeJapaneseChunked(text);
    }
    throw new Error('Failed to parse breakdown response');
  }
}

// ============================================
// Gemini Audio Analysis (duplicated from api.js)
// ============================================

function sanitizeTranscription(text) {
  if (!text) return text;

  // Fix hex-encoded UTF-8 bytes: <0xE3><0x81><0xAA> → な
  text = text.replace(/(?:<0x([0-9A-Fa-f]{2})>)+/g, (match) => {
    const bytes = [];
    match.replace(/<0x([0-9A-Fa-f]{2})>/g, (_, hex) => {
      bytes.push(parseInt(hex, 16));
    });
    try {
      return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    } catch { return match; }
  });

  // Strip hallucinated timestamps: 00時00分00秒, 00:00:00, etc.
  text = text.replace(/\d{1,2}時\d{1,2}分\d{1,2}秒/g, '');
  text = text.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '');

  // Clean up dangling particles left after removed timestamps
  text = text.replace(/^\s*(?:から|まで|にかけて)\s*/g, '');
  text = text.replace(/\s*(?:から|まで|にかけて)\s*(?=(?:から|まで|にかけて|、|。|$))/g, '');

  // Collapse leftover punctuation and whitespace
  text = text.replace(/[、。]\s*[、。]/g, '、');
  text = text.replace(/^\s*[、。]\s*/, '');
  text = text.replace(/\s+/g, ' ');

  return text.trim();
}

async function transcribeAudioOnly(base64Audio, mimeType) {
  const { apiBase, apiKey: resolvedKey } = await resolveAuth();

  const prompt = `Transcribe this Japanese audio. Output ONLY the transcribed Japanese text, nothing else. No translation, no explanation, no quotes, no markdown. Do NOT include timestamps, timecodes, or time references (00:00, 00時00分). If no Japanese speech is detected, output an empty string.`;

  const response = await fetch(
    `${apiBase}/v1beta/models/${modelId}:generateContent?key=${resolvedKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType, data: base64Audio } },
            { text: prompt }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Transcription failed');
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  const usageMetadata = data.usageMetadata;
  if (usageMetadata?.totalTokenCount) {
    updateTokenUsage(usageMetadata.totalTokenCount);
  }

  if (text === undefined || text === null) {
    const blockReason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Audio blocked: ${blockReason}` : 'No transcription returned');
  }

  return sanitizeTranscription(text.trim().replace(/^["「『]|["」』]$/g, '').trim());
}

function recordWordFrequencies(words) {
  const now = Date.now();
  chrome.storage.local.get(['wordFrequencyData'], (result) => {
    const data = result.wordFrequencyData || {
      version: 1, lastUpdated: now, totalWords: 0, uniqueWords: 0, words: {}
    };

    let totalCountAdded = 0;
    for (const word of words) {
      const key = `${word.japanese}|${word.type}`;
      if (data.words[key]) {
        data.words[key].count++;
        data.words[key].lastSeen = now;
      } else {
        data.words[key] = {
          japanese: word.japanese, reading: word.reading || '',
          romaji: word.romaji, english: word.english, type: word.type,
          count: 1, firstSeen: now, lastSeen: now
        };
      }
      totalCountAdded++;
    }

    data.totalWords += totalCountAdded;
    data.uniqueWords = Object.keys(data.words).length;
    data.lastUpdated = now;
    chrome.storage.local.set({ wordFrequencyData: data });
  });
}

// ============================================
// Status helpers
// ============================================

function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
  if (statusRow) statusRow.classList.toggle('listening', state === 'listening');
}

// ============================================
// Audio level indicator
// ============================================

function updateAudioLevel() {
  if (!isListening) {
    audioLevelBar.style.width = '0%';
    if (segmentTimerEl) segmentTimerEl.textContent = '';
    return;
  }

  const pct = Math.min(100, (currentRMS / 80) * 100);
  audioLevelBar.style.width = pct + '%';

  if (segmentTimerEl && segmentStart) {
    const elapsed = ((Date.now() - segmentStart) / 1000).toFixed(1);
    segmentTimerEl.textContent = elapsed + 's';
  }
}

// ============================================
// Card rendering
// ============================================

function buildWordBlock(word) {
  const block = document.createElement('div');
  block.className = 'word-block';
  const typeClass = getWordTypeClass(word.type);
  const typeLabel = typeClass.charAt(0).toUpperCase() + typeClass.slice(1);
  block.innerHTML = `
    <span class="word-japanese type-${typeClass}" data-type="${typeLabel}">${word.japanese}</span>
    <span class="word-hiragana">${word.reading || word.japanese}</span>
    <span class="word-romaji">${word.romaji || '-'}</span>
    <span class="word-english">${word.english || '-'}</span>
  `;
  return block;
}

function buildChevronToggle(collapsible) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'breakdown-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Toggle word breakdown');
  toggle.innerHTML = '<span class="chevron">▸</span>';
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    toggle.classList.toggle('expanded', !expanded);
    collapsible.classList.toggle('collapsed', expanded);
  });
  return toggle;
}

function buildSegmentHeader(timestampEl, collapsible) {
  const header = document.createElement('div');
  header.className = 'segment-header';
  if (collapsible) header.appendChild(buildChevronToggle(collapsible));
  header.appendChild(timestampEl);
  return header;
}

function buildAnalyzingIndicator() {
  const el = document.createElement('span');
  el.className = 'segment-analyzing';
  el.textContent = 'Analyzing words...';
  return el;
}

function showSuccessThenRemove(header) {
  const success = document.createElement('span');
  success.className = 'segment-success';
  success.textContent = '';
  header.appendChild(success);
  setTimeout(() => success.remove(), 2300);
}

function buildCollapsibleBreakdown(breakdown) {
  const collapsible = document.createElement('div');
  collapsible.className = 'breakdown-collapsible collapsed';

  const inner = document.createElement('div');
  inner.className = 'breakdown-collapsible-inner';
  collapsible.appendChild(inner);

  const wrapper = document.createElement('div');
  wrapper.className = 'breakdown-wrapper';
  breakdown.words.forEach(word => wrapper.appendChild(buildWordBlock(word)));
  inner.appendChild(wrapper);

  return collapsible;
}

function buildTranslation(breakdown) {
  if (!breakdown.translation) return null;
  const translationDiv = document.createElement('div');
  translationDiv.className = 'breakdown-translation';
  translationDiv.textContent = `"${breakdown.translation}"`;
  return translationDiv;
}

function createBreakdownCard(breakdown, originalText) {
  const card = document.createElement('div');
  card.className = 'segment-card';

  const timestamp = document.createElement('div');
  timestamp.className = 'segment-timestamp';
  timestamp.textContent = new Date().toLocaleTimeString();

  const collapsible = buildCollapsibleBreakdown(breakdown);
  card.appendChild(buildSegmentHeader(timestamp, collapsible));

  const original = document.createElement('div');
  original.className = 'segment-original';
  original.textContent = originalText;
  card.appendChild(original);

  card.appendChild(collapsible);

  const translation = buildTranslation(breakdown);
  if (translation) card.appendChild(translation);

  return card;
}

function createPendingCard(label) {
  const card = document.createElement('div');
  card.className = 'segment-card pending';

  const timestamp = document.createElement('div');
  timestamp.className = 'segment-timestamp';
  timestamp.textContent = new Date().toLocaleTimeString();
  card.appendChild(timestamp);

  const original = document.createElement('div');
  original.className = 'segment-original';
  original.textContent = label;
  card.appendChild(original);

  const loading = document.createElement('div');
  loading.textContent = 'Transcribing...';
  loading.style.color = '#9CA3AF';
  loading.style.fontSize = '13px';
  loading.style.fontStyle = 'italic';
  card.appendChild(loading);

  return card;
}

/**
 * Card shown the moment we have raw transcription text but no breakdown yet.
 * The text is rendered gray (via [data-mm-colored="false"]); paintWordColoring
 * later flips it to "true" and replaces innerHTML with colored hoverable spans.
 */
function createGrayTranscriptCard(text) {
  const card = document.createElement('div');
  card.className = 'segment-card analyzing';
  card.setAttribute('data-mm-words-root', '');

  const timestamp = document.createElement('div');
  timestamp.className = 'segment-timestamp';
  timestamp.textContent = new Date().toLocaleTimeString();

  const header = buildSegmentHeader(timestamp, null);
  header.appendChild(buildAnalyzingIndicator());
  card.appendChild(header);

  const original = document.createElement('div');
  original.className = 'segment-original';
  original.setAttribute('data-mm-colored', 'false');
  original.textContent = text;
  card.appendChild(original);

  return card;
}

/**
 * Upgrade a gray card in-place with the full breakdown: colorized text +
 * hover, per-word block grid, and translation.
 */
function upgradeGrayCardWithBreakdown(card, breakdown) {
  const original = card.querySelector('.segment-original');
  const loading = card.querySelector('.segment-analyzing');
  if (original) {
    paintWordColoring(original, breakdown.original, breakdown.words);
    attachHoverListeners(card, breakdown);
  }
  if (loading) loading.remove();
  card.classList.remove('analyzing');

  const collapsible = buildCollapsibleBreakdown(breakdown);
  card.appendChild(collapsible);

  const translation = buildTranslation(breakdown);
  if (translation) card.appendChild(translation);

  let header = card.querySelector('.segment-header');
  if (!header) {
    const timestamp = card.querySelector('.segment-timestamp');
    if (timestamp) {
      header = buildSegmentHeader(timestamp, collapsible);
      card.insertBefore(header, card.firstChild);
    }
  } else if (!header.querySelector('.breakdown-toggle')) {
    header.insertBefore(buildChevronToggle(collapsible), header.firstChild);
  }

  if (header) showSuccessThenRemove(header);
}

/**
 * Replace the "Analyzing words..." line with a small retry affordance while
 * keeping the gray transcription visible.
 */
function markCardBreakdownFailed(card, errorMessage, onRetry) {
  const loading = card.querySelector('.segment-analyzing');
  if (loading) loading.remove();

  const errBlock = document.createElement('div');
  errBlock.className = 'segment-breakdown-error';
  const msg = document.createElement('span');
  msg.textContent = errorMessage;
  errBlock.appendChild(msg);

  const retry = document.createElement('button');
  retry.className = 'btn-retry';
  retry.textContent = 'Retry breakdown';
  retry.addEventListener('click', () => {
    errBlock.remove();
    const loadingAgain = buildAnalyzingIndicator();
    const header = card.querySelector('.segment-header');
    if (header) header.appendChild(loadingAgain);
    else card.appendChild(loadingAgain);
    onRetry();
  });
  errBlock.appendChild(retry);
  card.appendChild(errBlock);
}

function createErrorCard(label, error, retryFn) {
  const card = document.createElement('div');
  card.className = 'segment-card error';

  const timestamp = document.createElement('div');
  timestamp.className = 'segment-timestamp';
  timestamp.textContent = new Date().toLocaleTimeString();
  card.appendChild(timestamp);

  const original = document.createElement('div');
  original.className = 'segment-original';
  original.textContent = label;
  card.appendChild(original);

  const errorDiv = document.createElement('div');
  errorDiv.className = 'segment-error';
  errorDiv.textContent = error;
  card.appendChild(errorDiv);

  if (retryFn) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn-retry';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => {
      card.remove();
      retryFn();
    });
    card.appendChild(retryBtn);
  }

  return card;
}

// ============================================
// Audio analysis pipeline
// ============================================

async function processAudioSegment(blob) {
  const durationLabel = ((Date.now() - (segmentStart || Date.now())) / 1000).toFixed(1) + 's audio';

  historyEmpty.style.display = 'none';
  const spinnerCard = createPendingCard(durationLabel);
  historyContainer.insertBefore(spinnerCard, historyContainer.firstChild);

  let arrayBuffer;
  let base64;
  try {
    arrayBuffer = await blob.arrayBuffer();
    base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );
  } catch (error) {
    spinnerCard.remove();
    const errorCard = createErrorCard(durationLabel, error.message, () => processAudioSegment(blob));
    historyContainer.insertBefore(errorCard, historyContainer.firstChild);
    return;
  }

  // Stage 1 — fast transcribe-only call. Shows gray text ASAP.
  let rawText;
  try {
    rawText = await transcribeAudioOnly(base64, 'audio/webm;codecs=opus');
  } catch (error) {
    spinnerCard.remove();
    const errorCard = createErrorCard(durationLabel, error.message, () => processAudioSegment(blob));
    historyContainer.insertBefore(errorCard, historyContainer.firstChild);
    return;
  }

  spinnerCard.remove();

  // Empty response means no speech detected — discard silently
  if (!rawText || rawText.trim() === '') {
    return;
  }

  const grayCard = createGrayTranscriptCard(rawText);
  historyContainer.insertBefore(grayCard, historyContainer.firstChild);

  accumulatedTranscript += rawText + ' ';
  if (isListening) {
    analyzeNowBtn.disabled = false;
  }

  // Stage 2 — full breakdown analysis. Upgrades the gray card in place.
  await runBreakdownForCard(grayCard, rawText);
}

async function runBreakdownForCard(card, text) {
  try {
    const breakdown = await analyzeJapaneseWithGemini(text);
    if (!card.isConnected) return;

    // Ensure breakdown.original matches what we display so word boundaries align.
    breakdown.original = text;

    upgradeGrayCardWithBreakdown(card, breakdown);

    recordWordFrequencies(breakdown.words);

    segmentCount++;
    wordCount += breakdown.words.length;
    if (segmentsProcessedEl) segmentsProcessedEl.textContent = segmentCount;
    if (wordsAnalyzedEl) wordsAnalyzedEl.textContent = wordCount;
  } catch (error) {
    if (!card.isConnected) return;
    markCardBreakdownFailed(card, error.message, () => runBreakdownForCard(card, text));
  }
}

// Text re-analysis (for "Analyze Now" button)
async function sendForAnalysis(text) {
  if (!text.trim()) return;

  historyEmpty.style.display = 'none';
  setStatus('processing', 'Processing...');
  analyzeNowBtn.disabled = true;

  const pendingCard = createPendingCard(text);
  historyContainer.insertBefore(pendingCard, historyContainer.firstChild);

  try {
    const breakdown = await analyzeJapaneseWithGemini(text);
    pendingCard.remove();

    const breakdownCard = createBreakdownCard(breakdown, text);
    historyContainer.insertBefore(breakdownCard, historyContainer.firstChild);

    recordWordFrequencies(breakdown.words);

    segmentCount++;
    wordCount += breakdown.words.length;
    if (segmentsProcessedEl) segmentsProcessedEl.textContent = segmentCount;
    if (wordsAnalyzedEl) wordsAnalyzedEl.textContent = wordCount;
  } catch (error) {
    pendingCard.remove();
    const errorCard = createErrorCard(text, error.message, () => sendForAnalysis(text));
    historyContainer.insertBefore(errorCard, historyContainer.firstChild);
  }

  if (isListening) {
    setStatus('listening', 'Listening...');
  } else {
    setStatus('ready', 'Ready');
  }
}

// ============================================
// Audio capture (mirrors offscreen.js pattern)
// ============================================

async function initAudioCapture() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);

    // Suspend until user click (Chrome autoplay policy)
    audioContext.suspend();
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      warningNoMic.textContent = 'Microphone access denied. Please allow mic access and reload.';
    } else {
      warningNoMic.textContent = 'Failed to access microphone: ' + err.message;
    }
    warningNoMic.style.display = 'block';
    micBtn.disabled = true;
  }
}

function startNewRecording() {
  recordedChunks = [];
  speechSamples = 0;
  totalSamples = 0;
  segmentStart = Date.now();

  mediaRecorder = new MediaRecorder(mediaStream, {
    mimeType: 'audio/webm;codecs=opus'
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    if (recordedChunks.length > 0) {
      const speechRatio = totalSamples > 0 ? speechSamples / totalSamples : 0;
      if (speechRatio >= MIN_SPEECH_RATIO) {
        const blob = new Blob(recordedChunks, { type: 'audio/webm;codecs=opus' });
        processAudioSegment(blob);
      }
    }
  };

  mediaRecorder.start(100);
  silenceStart = null;
}

function checkSilence() {
  if (!analyser || !isListening) return;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(dataArray);

  // Calculate RMS volume
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const val = (dataArray[i] - 128) / 128;
    sum += val * val;
  }
  currentRMS = Math.sqrt(sum / dataArray.length) * 255;

  totalSamples++;
  if (currentRMS >= SILENCE_RMS_THRESHOLD) {
    speechSamples++;
  }

  updateAudioLevel();

  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;

  const now = Date.now();
  const segmentDuration = now - segmentStart;

  // Force segment boundary at max duration
  if (segmentDuration >= MAX_SEGMENT_DURATION) {
    finalizeSegment();
    return;
  }

  if (currentRMS < SILENCE_RMS_THRESHOLD) {
    if (!silenceStart) {
      silenceStart = now;
    } else if (now - silenceStart >= silenceThreshold && segmentDuration >= MIN_SEGMENT_DURATION) {
      finalizeSegment();
    }
  } else {
    silenceStart = null;
  }
}

function finalizeSegment() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;

  mediaRecorder.stop();

  // Start new recording after brief delay
  setTimeout(() => {
    if (mediaStream && mediaStream.active && isListening) {
      startNewRecording();
    }
  }, 50);
}

// ============================================
// Start / Stop
// ============================================

async function startListening() {
  if (!audioContext || !mediaStream) return;

  isListening = true;
  accumulatedTranscript = '';

  await audioContext.resume();
  startNewRecording();
  silenceCheckInterval = setInterval(checkSilence, 100);

  micBtn.classList.add('listening');
  setStatus('listening', 'Listening...');
}

function stopListening() {
  isListening = false;

  if (silenceCheckInterval) {
    clearInterval(silenceCheckInterval);
    silenceCheckInterval = null;
  }

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop(); // triggers final segment processing
  }

  micBtn.classList.remove('listening');
  currentRMS = 0;
  updateAudioLevel();

  if (accumulatedTranscript.trim()) {
    analyzeNowBtn.disabled = false;
  } else {
    analyzeNowBtn.disabled = true;
  }

  setStatus('ready', 'Ready');
}

// ============================================
// Copy / Download transcript
// ============================================

function collectTranscriptData() {
  const cards = Array.from(
    historyContainer.querySelectorAll('.segment-card:not(.pending):not(.error)')
  ).reverse(); // DOM is newest-first, reverse for chronological
  return cards.map(card => ({
    timestamp: card.querySelector('.segment-timestamp')?.textContent || '',
    japanese: card.querySelector('.segment-original')?.textContent || '',
    english: (card.querySelector('.breakdown-translation')?.textContent || '').replace(/^"|"$/g, '')
  }));
}

function flashCopied(btn) {
  btn.classList.add('copied');
  setTimeout(() => btn.classList.remove('copied'), 1200);
}

function buildTranscriptText(variant, data) {
  if (variant === 'jp') return data.map(d => d.japanese).join('\n');
  if (variant === 'en') return data.map(d => d.english).join('\n');
  return data.map(d => `[${d.timestamp}]\n${d.japanese}\n${d.english}\n`).join('\n');
}

function downloadText(text, variant) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transcript-${variant}-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

if (historyActions) {
  historyActions.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-icon');
    if (!btn) return;
    const action = btn.dataset.action;
    const variant = btn.dataset.variant;
    const data = collectTranscriptData();
    if (!data.length) return;
    const text = buildTranscriptText(variant, data);
    if (action === 'copy') {
      navigator.clipboard.writeText(text);
      flashCopied(btn);
    } else if (action === 'download') {
      downloadText(text, variant);
    }
  });
}

// ============================================
// Event listeners
// ============================================

micBtn.addEventListener('click', () => {
  if (isListening) {
    stopListening();
  } else {
    startListening();
  }
});

analyzeNowBtn.addEventListener('click', () => {
  if (accumulatedTranscript.trim()) {
    const text = accumulatedTranscript;
    accumulatedTranscript = '';
    analyzeNowBtn.disabled = true;
    sendForAnalysis(text);
  }
});

const SETTINGS_KEYS = ['silenceThreshold', 'maxSegmentDuration', 'silenceRmsThreshold', 'minSegmentDuration'];

function applySilence(seconds) {
  silenceThreshold = seconds * 1000;
  silenceSlider.value = seconds;
  silenceValue.textContent = seconds + 's';
}
function applyMaxDuration(seconds) {
  MAX_SEGMENT_DURATION = seconds * 1000;
  maxDurationSlider.value = seconds;
  maxDurationValue.textContent = seconds + 's';
}
function applySensitivity(val) {
  SILENCE_RMS_THRESHOLD = val;
  sensitivitySlider.value = val;
  sensitivityValue.textContent = val;
}
function applyMinDuration(ms) {
  MIN_SEGMENT_DURATION = ms;
  minDurationSlider.value = ms;
  minDurationValue.textContent = ms + 'ms';
}

function saveSetting(key, value) {
  chrome.storage.sync.set({ [key]: value });
}

chrome.storage.sync.get(SETTINGS_KEYS, (stored) => {
  if (typeof stored.silenceThreshold === 'number') applySilence(stored.silenceThreshold / 1000);
  if (typeof stored.maxSegmentDuration === 'number') applyMaxDuration(stored.maxSegmentDuration / 1000);
  if (typeof stored.silenceRmsThreshold === 'number') applySensitivity(stored.silenceRmsThreshold);
  if (typeof stored.minSegmentDuration === 'number') applyMinDuration(stored.minSegmentDuration);
});

silenceSlider.addEventListener('input', () => {
  const val = parseFloat(silenceSlider.value);
  applySilence(val);
  saveSetting('silenceThreshold', silenceThreshold);
});
maxDurationSlider.addEventListener('input', () => {
  const val = parseInt(maxDurationSlider.value, 10);
  applyMaxDuration(val);
  saveSetting('maxSegmentDuration', MAX_SEGMENT_DURATION);
});
sensitivitySlider.addEventListener('input', () => {
  const val = parseInt(sensitivitySlider.value, 10);
  applySensitivity(val);
  saveSetting('silenceRmsThreshold', val);
});
minDurationSlider.addEventListener('input', () => {
  const val = parseInt(minDurationSlider.value, 10);
  applyMinDuration(val);
  saveSetting('minSegmentDuration', val);
});

// Listen for storage changes (user sets API key while page is open)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (changes.geminiApiKey) {
      apiKey = changes.geminiApiKey.newValue || null;
      warningNoKey.style.display = apiKey ? 'none' : 'block';
    }
    if (changes.geminiModel) {
      modelId = changes.geminiModel.newValue || 'gemini-2.5-flash-lite';
    }
  }
});

// ============================================
// Initialization
// ============================================

async function init() {
  apiKey = await getApiKey();
  modelId = await getModel();

  if (!apiKey) {
    warningNoKey.style.display = 'block';
  }

  await initAudioCapture();
}

init();
