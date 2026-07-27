// ============================================
// Live Japanese Transcription Page
// Chrome's Web Speech API turns speech into text; the on-device pipeline
// (kuromoji + JMdict) breaks each utterance into words.
// ============================================

import { analyzeJapanese } from '../../content/core/api.js';
import { getWordTypeClass } from '../../content/utils/text.js';
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
const modeNote = document.getElementById('modeNote');
if (settingsBtn && silenceControls) {
  settingsBtn.addEventListener('click', () => {
    const collapsed = silenceControls.classList.toggle('collapsed');
    settingsBtn.classList.toggle('active', !collapsed);
    settingsBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
}

// --- State ---
let isListening = false;
let segmentCount = 0;
let wordCount = 0;
let accumulatedTranscript = ''; // transcribed text for "Analyze Now" re-analysis

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
  if (liveCaptionEl) liveCaptionEl.textContent = '';

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
    const breakdown = await analyzeJapanese(text);
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
    const breakdown = await analyzeJapanese(text);
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


// Tear down whatever audio graph is active (used by both modes on stop).
function teardownAudio() {
  stopMeter();
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
      finalizeUtterance(text);
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
// Start / Stop
// ============================================

async function startDictationMode() {
  if (!recognition && !initSpeechRecognition()) return false;
  shouldRestart = true;
  await startDictationMeter();
  try { recognition.start(); } catch { /* already started */ }
  setStatus('listening', 'Listening...');
  return true;
}



async function startListening() {
  if (isListening) return;
  warningNoMic.style.display = 'none';
  isListening = true;
  accumulatedTranscript = '';
  micBtn.classList.add('listening');

  const ok = await startDictationMode();

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

// ============================================
// Initialization
// ============================================

function init() {
  initSpeechRecognition();
}

init();
