// ============================================
// Live Japanese Transcription Page
// Uses MediaRecorder + Gemini audio API for transcription + analysis
// ============================================

import { initDisplayPreferences } from '../../content/core/display-preferences.js';
import { mergeWordCounts } from '../../content/core/frequency-store.js';
import { paintWordColoring } from '../../content/shared/word-render.js';
import { attachHoverListeners } from '../../content/meet/hover-card.js';
import { initAnkiQuickAdd, attachAnkiContextMenu } from '../../content/chat/anki-quick-add.js';

initDisplayPreferences();
initAnkiQuickAdd();
attachAnkiContextMenu();

// --- DOM refs ---
const micBtn = document.getElementById('micBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statusRow = document.getElementById('statusRow');
const warningNoKey = document.getElementById('warningNoKey');
const warningNoMic = document.getElementById('warningNoMic');
const analyzeNowBtn = document.getElementById('analyzeNow');
const audioLevelBar = document.getElementById('audioLevelBar');
const segmentsProcessedEl = document.getElementById('segmentsProcessed');
const wordsAnalyzedEl = document.getElementById('wordsAnalyzed');
const historyContainer = document.getElementById('historyContainer');
const historyEmpty = document.getElementById('historyEmpty');
const historyActions = document.getElementById('historyActions');
const settingsBtn = document.getElementById('settingsBtn');
const silenceControls = document.getElementById('silenceControls');
const modeToggle = document.getElementById('modeToggle');
const modeNote = document.getElementById('modeNote');
const liveModelInput = document.getElementById('liveModelInput');
if (settingsBtn && silenceControls) {
  settingsBtn.addEventListener('click', () => {
    const collapsed = silenceControls.classList.toggle('collapsed');
    settingsBtn.classList.toggle('active', !collapsed);
    settingsBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
}

// --- API base ---
const CLOUD_API_BASE = 'https://generativelanguage.googleapis.com';

async function resolveAuth() {
  const key = await getApiKey();
  if (!key) throw new Error('No API key. Set it in the extension popup.');
  return { apiBase: CLOUD_API_BASE, apiKey: key };
}

// --- State ---
let apiKey = null;
let modelId = 'gemini-2.5-flash-lite';
let isListening = false;
let segmentCount = 0;
let wordCount = 0;
let accumulatedTranscript = ''; // transcribed text for "Analyze Now" re-analysis

// --- Transcription mode ---
// 'dictation' = Web Speech API (instant, free, close mic).
// 'meeting'   = Gemini Live API (high recall, far-field, streams audio).
let transcribeMode = 'dictation';
let liveModelId = 'gemini-2.0-flash-live-001';
let liveModelUserSet = false; // true once the user manually edits the model field

// --- Speech recognition state ---
// We stream live captions via the Web Speech API (the same engine Chrome/Meet
// use). It emits interim results as you speak and a final result once the
// engine settles, so there's no record-then-batch latency.
let recognition = null;
const RECOGNITION_LANG = 'ja-JP';
let shouldRestart = false; // drives onend auto-restart while listening
let liveCaptionEl = null;  // pinned interim caption line at top of history

// --- Breakdown queue (order-preserving, concurrency-capped) ---
const MAX_CONCURRENT_BREAKDOWNS = 3;
let activeBreakdowns = 0;
const breakdownQueue = [];

// --- Audio meter state (mic VU bar only; recognizer manages its own audio) ---
let mediaStream = null;
let audioContext = null;
let analyser = null;
let meterInterval = null;
let currentRMS = 0;

// --- Meeting mode (Gemini Live) state ---
const LIVE_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
let liveSocket = null;       // active WebSocket
let liveWorkletNode = null;  // AudioWorkletNode producing PCM
let liveSetupDone = false;   // server acknowledged setup for the current socket
let liveHadSession = false;  // setup succeeded at least once this listening session
let liveBuffer = '';         // accumulated input-transcription for the current turn
let liveReconnecting = false;
let liveResponseModality = 'TEXT'; // 'TEXT' for half-cascade models; falls back to 'AUDIO' for native-audio

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
  // Offline NLP beta: route through service worker -> offscreen pipeline.
  const offlineEnabled = await new Promise((r) => {
    try { chrome.storage.sync.get(['useOfflineNlp'], (s) => r(s?.useOfflineNlp !== false)); } catch { r(true); }
  });
  if (offlineEnabled) {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'kaigi-nlp-proxy', op: 'analyze', text }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp || { ok: false, error: 'no response' });
      });
    });
    if (!response.ok) throw new Error(response.error || 'offline NLP failed');
    return response.result;
  }

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

function recordWordFrequencies(words) {
  const now = Date.now();

  // Collapse repeats within this batch first, so a word said three times costs
  // one merged update rather than three round trips.
  const updates = new Map();
  for (const word of words) {
    const key = `${word.japanese}|${word.type}`;
    const existing = updates.get(key);
    if (existing) {
      existing.count++;
      existing.lastSeen = now;
      continue;
    }
    updates.set(key, {
      japanese: word.japanese, reading: word.reading || '',
      romaji: word.romaji, english: word.english, type: word.type,
      count: 1, firstSeen: now, lastSeen: now
    });
  }

  mergeWordCounts(updates).catch(err => {
    console.warn('[transcribe] frequency save failed:', err?.message || err);
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
    return;
  }
  const pct = Math.min(100, (currentRMS / 80) * 100);
  audioLevelBar.style.width = pct + '%';
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
// Live caption + finalized-segment pipeline
// ============================================

// Show/replace the interim (not-yet-final) transcript line, pinned at the very
// top of the history so it reads top-down: [live][newest card][older cards].
function updateLiveCaption(text) {
  if (!liveCaptionEl) {
    liveCaptionEl = document.createElement('div');
    liveCaptionEl.className = 'live-caption';
  }
  // Keep it pinned to the top (insertBefore moves an already-attached node).
  if (historyContainer.firstChild !== liveCaptionEl) {
    historyContainer.insertBefore(liveCaptionEl, historyContainer.firstChild);
  }
  liveCaptionEl.textContent = text;
  if (text) historyEmpty.style.display = 'none';
}

// A final transcript arrived: drop it from the live line, create its gray card
// in chronological order, and queue the word breakdown.
function finalizeUtterance(text) {
  historyEmpty.style.display = 'none';
  // In hybrid, Web Speech keeps driving the live line, so don't wipe it.
  if (transcribeMode !== 'hybrid' && liveCaptionEl) liveCaptionEl.textContent = '';

  const grayCard = createGrayTranscriptCard(text);
  // Insert just below the (pinned) live line so newest cards stay on top.
  if (liveCaptionEl && liveCaptionEl.parentNode === historyContainer) {
    historyContainer.insertBefore(grayCard, liveCaptionEl.nextSibling);
  } else {
    historyContainer.insertBefore(grayCard, historyContainer.firstChild);
  }

  accumulatedTranscript += text + ' ';
  if (analyzeNowBtn) analyzeNowBtn.disabled = false;

  enqueueBreakdown(grayCard, text);
}

// Order-preserving, concurrency-capped breakdown queue. Cards are created at
// finalize time (correct order) and upgraded in place, so breakdowns can run
// concurrently without blocking or reordering one another.
function enqueueBreakdown(card, text) {
  breakdownQueue.push({ card, text });
  pumpBreakdownQueue();
}

function pumpBreakdownQueue() {
  while (activeBreakdowns < MAX_CONCURRENT_BREAKDOWNS && breakdownQueue.length > 0) {
    const { card, text } = breakdownQueue.shift();
    activeBreakdowns++;
    // runBreakdownForCard handles its own errors (retry affordance), so this
    // promise never rejects.
    runBreakdownForCard(card, text).finally(() => {
      activeBreakdowns--;
      pumpBreakdownQueue();
    });
  }
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
// Mic capture / audio graph (per mode)
// ============================================

function buildAnalyser(source) {
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.3;
  source.connect(analyser);
}

// Dictation mode: the recognizer captures its own audio; this stream drives
// only the VU meter ("I can hear you" feedback). Failure here is non-fatal.
async function startDictationMeter() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    audioContext = new AudioContext();
    buildAnalyser(audioContext.createMediaStreamSource(mediaStream));
    startMeter();
  } catch {
    /* meter is optional; Web Speech still works without our stream */
  }
}

// Meeting mode: WE own the audio. Far-field tuning (EC/NS off so distant speech
// isn't stripped, AGC on to lift it), mono, 16kHz so the worklet emits exactly
// the PCM the Live API wants. Throws on permission failure (caller handles).
async function startMeetingAudio() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 }
  });
  audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);
  buildAnalyser(source);

  await audioContext.audioWorklet.addModule(
    chrome.runtime.getURL('src/pages/transcribe/pcm-worklet.js')
  );
  liveWorkletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
  source.connect(liveWorkletNode);
  // Route through a muted gain to keep the worklet processing without audible
  // playback (which would feed back into the mic).
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  liveWorkletNode.connect(mute).connect(audioContext.destination);
  liveWorkletNode.port.onmessage = (e) => sendAudioChunk(e.data);

  startMeter();
}

// Tear down whatever audio graph is active (used by both modes on stop).
function teardownAudio() {
  stopMeter();
  if (liveWorkletNode) {
    try { liveWorkletNode.port.onmessage = null; liveWorkletNode.disconnect(); } catch { /* already gone */ }
    liveWorkletNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    try { audioContext.close(); } catch { /* already closed */ }
    audioContext = null;
    analyser = null;
  }
}

// ============================================
// Mic VU meter (visual "I can hear you" feedback only)
// ============================================

function sampleMeter() {
  if (!analyser) return;
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(dataArray);
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const val = (dataArray[i] - 128) / 128;
    sum += val * val;
  }
  currentRMS = Math.sqrt(sum / dataArray.length) * 255;
  updateAudioLevel();
}

function startMeter() {
  if (meterInterval || !analyser) return;
  meterInterval = setInterval(sampleMeter, 100);
}

function stopMeter() {
  if (meterInterval) {
    clearInterval(meterInterval);
    meterInterval = null;
  }
}

// ============================================
// Speech recognition (Web Speech API streaming)
// ============================================

function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    warningNoMic.textContent = 'Speech recognition is not available in this browser. Please use Chrome.';
    warningNoMic.style.display = 'block';
    micBtn.disabled = true;
    return false;
  }
  recognition = new SR();
  recognition.lang = RECOGNITION_LANG;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onresult = handleSpeechResult;
  recognition.onend = handleSpeechEnd;
  recognition.onerror = handleSpeechError;
  return true;
}

function handleSpeechResult(event) {
  let interim = '';
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    const transcript = result[0].transcript;
    if (result.isFinal) {
      const text = transcript.trim();
      if (!text) continue;
      // Hybrid: Web Speech is a preview only — Gemini owns the cards. Keep the
      // final text in the live line (it'll be replaced by the next utterance).
      if (transcribeMode === 'hybrid') interim += transcript;
      else finalizeUtterance(text);
    } else {
      interim += transcript;
    }
  }
  updateLiveCaption(interim);
}

// The engine self-terminates after pauses (and ~60s of audio). Restart it so
// transcription continues seamlessly for as long as the user is listening.
function handleSpeechEnd() {
  if (!shouldRestart || !isListening) {
    setStatus('ready', 'Ready');
    return;
  }
  restartRecognition();
}

function restartRecognition() {
  try {
    recognition.start();
    setStatus('listening', 'Listening...');
  } catch {
    // Engine not fully released yet; retry shortly.
    setTimeout(() => {
      if (shouldRestart && isListening) restartRecognition();
    }, 200);
  }
}

function handleSpeechError(event) {
  const err = event.error;
  if (err === 'no-speech' || err === 'aborted') {
    return; // benign; onend handles any restart
  }
  if (err === 'not-allowed' || err === 'service-not-allowed') {
    shouldRestart = false;
    isListening = false;
    stopMeter();
    warningNoMic.textContent = 'Microphone access denied. Please allow mic access and reload.';
    warningNoMic.style.display = 'block';
    micBtn.classList.remove('listening');
    setStatus('ready', 'Ready');
    return;
  }
  if (err === 'network') {
    setStatus('processing', 'Reconnecting...');
    return; // onend will restart
  }
  console.warn('SpeechRecognition error:', err);
}

// ============================================
// Meeting mode (Gemini Live API streaming)
// ============================================

function openLiveSocket(key) {
  liveSetupDone = false;
  liveSocket = new WebSocket(`${LIVE_WS_URL}?key=${encodeURIComponent(key)}`);
  liveSocket.binaryType = 'arraybuffer';

  liveSocket.onopen = () => {
    // Half-cascade models accept TEXT (cheaper, no audio generated); native-audio
    // models only accept AUDIO. We try TEXT first and fall back to AUDIO on a
    // modality-mismatch error (see onclose). Either way we read only the input
    // transcription and ignore the model's reply.
    liveSocket.send(JSON.stringify({
      setup: {
        model: `models/${liveModelId}`,
        generationConfig: { responseModalities: [liveResponseModality] },
        // The Live API auto-detects the spoken language from the audio; it has no
        // setup field to pin a language, so we bias toward Japanese via the system
        // instruction below instead.
        inputAudioTranscription: {},
        systemInstruction: { parts: [{ text: 'You are a silent transcription engine for Japanese speech. Do not reply.' }] },
      }
    }));
  };

  liveSocket.onmessage = (ev) => { handleLiveMessage(ev.data); };

  liveSocket.onclose = (ev) => {
    // Ignore the close we triggered ourselves (liveSocket nulled in stop).
    if (!liveSocket || !isListening || (transcribeMode !== 'meeting' && transcribeMode !== 'hybrid')) return;
    flushLiveBuffer();
    if (!liveHadSession) {
      const reason = (ev && ev.reason) || '';
      // Native-audio models reject TEXT — retry once with AUDIO modality.
      if (liveResponseModality === 'TEXT' && /modalit/i.test(reason)) {
        liveResponseModality = 'AUDIO';
        reconnectLiveSocket();
        return;
      }
      // Otherwise closed before setup completed → fatal (bad key, model, quota).
      meetingFatal(reason);
      return;
    }
    reconnectLiveSocket();
  };

  liveSocket.onerror = () => { /* onclose follows and handles recovery */ };
}

function meetingFatal(reason) {
  warningNoMic.textContent =
    'Meeting mode could not connect' + (reason ? ` (${reason})` : '') +
    '. Check your API key and the Live model name.';
  warningNoMic.style.display = 'block';
  stopListening();
}

// Audio-only Live sessions cap at ~15 min; reconnect to keep going.
function reconnectLiveSocket() {
  if (liveReconnecting) return;
  liveReconnecting = true;
  setStatus('processing', 'Reconnecting...');
  setTimeout(async () => {
    liveReconnecting = false;
    if (!isListening || (transcribeMode !== 'meeting' && transcribeMode !== 'hybrid')) return;
    const key = await getApiKey();
    if (key) openLiveSocket(key);
  }, 600);
}

async function handleLiveMessage(data) {
  let text;
  if (typeof data === 'string') text = data;
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  else if (data && typeof data.text === 'function') text = await data.text(); // Blob
  else return;

  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg.setupComplete) {
    liveSetupDone = true;
    liveHadSession = true;
    setStatus('listening', 'Listening...');
    return;
  }

  const sc = msg.serverContent;
  if (!sc) return;

  // We only want the ASR of the room audio — ignore any model reply (modelTurn).
  const itext = sc.inputTranscription?.text;
  if (itext) {
    liveBuffer += itext;
    // In hybrid, Web Speech drives the live line; don't fight it. Gemini still
    // finalizes the accurate card on turnComplete.
    if (transcribeMode !== 'hybrid') updateLiveCaption(liveBuffer);
  }

  if (sc.turnComplete) flushLiveBuffer();
}

// Turn finished (or session ending): cut the buffered text into a card.
function flushLiveBuffer() {
  const text = liveBuffer.trim();
  liveBuffer = '';
  if (text) finalizeUtterance(text);
  else if (transcribeMode !== 'hybrid' && liveCaptionEl) liveCaptionEl.textContent = '';
}

function sendAudioChunk(int16) {
  if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN || !liveSetupDone) return;
  const bytes = new Uint8Array(int16.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  liveSocket.send(JSON.stringify({
    realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } }
  }));
}

// ============================================
// Start / Stop (dispatch on mode)
// ============================================

async function startDictationMode() {
  if (!recognition && !initSpeechRecognition()) return false;
  shouldRestart = true;
  await startDictationMeter();
  try { recognition.start(); } catch { /* already started */ }
  setStatus('listening', 'Listening...');
  return true;
}

async function startMeetingMode() {
  const key = await getApiKey();
  if (!key) {
    warningNoKey.style.display = 'block';
    return false;
  }
  setStatus('processing', 'Connecting...');
  liveHadSession = false;
  liveBuffer = '';
  liveResponseModality = 'TEXT'; // start cheap; onclose falls back to AUDIO if rejected
  try {
    await startMeetingAudio();
  } catch (err) {
    teardownAudio();
    warningNoMic.textContent = err && err.name === 'NotAllowedError'
      ? 'Microphone access denied. Please allow mic access and reload.'
      : 'Failed to start meeting capture: ' + (err?.message || err);
    warningNoMic.style.display = 'block';
    return false;
  }
  openLiveSocket(key);
  return true;
}

// Hybrid = Gemini (accurate cards) + Web Speech (instant ja-JP preview line).
async function startHybridMode() {
  const ok = await startMeetingMode();
  if (!ok) return false;
  if (recognition || initSpeechRecognition()) {
    shouldRestart = true;
    try { recognition.start(); } catch { /* already started */ }
  }
  return true;
}

async function startListening() {
  if (isListening) return;
  warningNoMic.style.display = 'none';
  isListening = true;
  accumulatedTranscript = '';
  micBtn.classList.add('listening');

  const ok = transcribeMode === 'meeting'
    ? await startMeetingMode()
    : transcribeMode === 'hybrid'
    ? await startHybridMode()
    : await startDictationMode();

  if (!ok) {
    isListening = false;
    micBtn.classList.remove('listening');
    setStatus('ready', 'Ready');
  }
}

function stopListening() {
  isListening = false;
  shouldRestart = false; // stop Web Speech auto-restart

  if (recognition) {
    try { recognition.stop(); } catch { /* not started */ }
  }

  if (liveSocket) {
    const sock = liveSocket;
    liveSocket = null; // signals onclose not to reconnect
    try { sock.close(); } catch { /* already closing */ }
  }
  liveSetupDone = false;
  flushLiveBuffer();

  teardownAudio();

  if (liveCaptionEl) liveCaptionEl.textContent = '';
  micBtn.classList.remove('listening');
  currentRMS = 0;
  updateAudioLevel();

  analyzeNowBtn.disabled = !accumulatedTranscript.trim();
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

// ============================================
// Mode toggle (Dictation / Meeting)
// ============================================

const MODE_NOTES = {
  dictation: 'Dictation streams in real time via Chrome\'s speech engine (free), best for a single close microphone. Use "Analyze Now" to re-run the word breakdown on everything captured so far.',
  meeting: 'Meeting mode streams mic audio to Gemini for high-recall transcription of far-field, multi-speaker conversations. Uses your API key — audio is billed while listening.',
  hybrid: 'Hybrid shows an instant live preview (Chrome speech engine) while accurate Gemini cards finalize a beat behind. Best of both — far-field accuracy with real-time feedback. Uses your API key.',
};

const VALID_MODES = ['dictation', 'meeting', 'hybrid'];

function applyMode(mode, persist) {
  transcribeMode = VALID_MODES.includes(mode) ? mode : 'dictation';
  if (modeToggle) {
    modeToggle.querySelectorAll('.mode-option').forEach((btn) => {
      const active = btn.dataset.mode === transcribeMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }
  if (modeNote) modeNote.textContent = MODE_NOTES[transcribeMode];
  if (persist) chrome.storage.sync.set({ transcribeMode });
}

if (modeToggle) {
  modeToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-option');
    if (!btn) return;
    const target = VALID_MODES.includes(btn.dataset.mode) ? btn.dataset.mode : 'dictation';
    if (target === transcribeMode) return;
    // Switch instantly: tear down the current session and restart in the new
    // mode (a switch is always between different modes, so we never stop/start
    // the same Web Speech recognizer).
    const wasListening = isListening;
    if (wasListening) stopListening();
    applyMode(target, true);
    if (wasListening) startListening();
  });
}

if (liveModelInput) {
  liveModelInput.addEventListener('change', () => {
    const val = liveModelInput.value.trim();
    liveModelId = val || liveModelId;
    liveModelInput.value = liveModelId;
    liveModelUserSet = true; // a manual choice — discovery must not override it
    chrome.storage.sync.set({ geminiLiveModel: liveModelId, geminiLiveModelUserSet: true });
  });
}

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
    if (changes.geminiLiveModel) {
      liveModelId = changes.geminiLiveModel.newValue || liveModelId;
    }
  }
});

// ============================================
// Live model discovery
// ============================================

// Prefer a half-cascade flash-live model: it honors the Japanese language lock
// and supports cheap TEXT output. Native-audio models (e.g. 3.x flash-live,
// *native-audio*) auto-detect language and ignore the lock, so they're last.
function pickPreferredLiveModel(models) {
  const halfCascade = (m) => !m.includes('native-audio') && !/gemini-3\./.test(m);
  return (
    models.find((m) => m === 'gemini-2.0-flash-live-001') ||
    models.find((m) => /^gemini-2\.0-flash-live/.test(m)) ||
    models.find((m) => m.includes('flash') && m.includes('live') && halfCascade(m)) ||
    models.find((m) => halfCascade(m)) ||
    models[0]
  );
}

// Ask the user's own key which models support bidiGenerateContent (Live API),
// so the field offers valid options instead of a guessed name that may 404.
// Populates the datalist and steers toward the Japanese-honoring default.
async function discoverLiveModels(key) {
  if (!key) return;
  let models;
  try {
    const res = await fetch(`${CLOUD_API_BASE}/v1beta/models?key=${key}&pageSize=1000`);
    if (!res.ok) return;
    const data = await res.json();
    models = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('bidiGenerateContent'))
      .map((m) => (m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  } catch {
    return; // keep the editable field + default
  }
  if (!models || models.length === 0) return;

  // Populate the datalist suggestions.
  const list = document.getElementById('liveModelOptions');
  if (list) {
    list.innerHTML = '';
    models.forEach((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      list.appendChild(opt);
    });
  }

  // Switch to the preferred model when the current one is invalid, or when the
  // user hasn't manually chosen and a better (Japanese-honoring) one exists.
  const preferred = pickPreferredLiveModel(models);
  const invalid = !models.includes(liveModelId);
  if (preferred && (invalid || (!liveModelUserSet && preferred !== liveModelId))) {
    liveModelId = preferred;
    if (liveModelInput) liveModelInput.value = liveModelId;
    chrome.storage.sync.set({ geminiLiveModel: liveModelId });
  }
}

// ============================================
// Initialization
// ============================================

async function init() {
  const stored = await new Promise((resolve) => {
    chrome.storage.sync.get(
      ['geminiApiKey', 'geminiModel', 'geminiLiveModel', 'geminiLiveModelUserSet', 'transcribeMode'],
      (s) => resolve(s || {})
    );
  });
  apiKey = stored.geminiApiKey || null;
  modelId = stored.geminiModel || 'gemini-2.5-flash-lite';
  if (stored.geminiLiveModel) liveModelId = stored.geminiLiveModel;
  liveModelUserSet = stored.geminiLiveModelUserSet === true;
  if (liveModelInput) liveModelInput.value = liveModelId;

  // Live transcription needs no key in Dictation mode; only the breakdown (and
  // Meeting mode) do. So this banner is informational and never blocks Dictation.
  if (!apiKey) {
    warningNoKey.style.display = 'block';
  }

  applyMode(stored.transcribeMode || 'dictation', false);
  initSpeechRecognition();
  discoverLiveModels(apiKey); // async; populates datalist + heals stale model
}

init();
