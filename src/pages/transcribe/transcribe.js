// ============================================
// Live Japanese Transcription Page
// Self-contained (no imports) — matches popup.js / frequency.js pattern
// Uses MediaRecorder + Gemini audio API for transcription + analysis
// ============================================

// --- DOM refs ---
const micBtn = document.getElementById('micBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const warningNoKey = document.getElementById('warningNoKey');
const warningNoMic = document.getElementById('warningNoMic');
const silenceSlider = document.getElementById('silenceSlider');
const silenceValue = document.getElementById('silenceValue');
const analyzeNowBtn = document.getElementById('analyzeNow');
const transcriptArea = document.getElementById('transcriptArea');
const transcriptPlaceholder = document.getElementById('transcriptPlaceholder');
const audioLevelBar = document.getElementById('audioLevelBar');
const segmentTimerEl = document.getElementById('segmentTimer');
const segmentsProcessedEl = document.getElementById('segmentsProcessed');
const wordsAnalyzedEl = document.getElementById('wordsAnalyzed');
const historyContainer = document.getElementById('historyContainer');
const historyEmpty = document.getElementById('historyEmpty');

// --- State ---
let apiKey = null;
let modelId = 'gemini-2.5-flash';
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

const SILENCE_RMS_THRESHOLD = 15;   // 0-255 scale
const MIN_SEGMENT_DURATION = 500;   // ms
const MAX_SEGMENT_DURATION = 15000; // ms
const MIN_SPEECH_RATIO = 0.10;      // Skip transcription if < 10% of samples had speech

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
      resolve(result.geminiModel || 'gemini-2.5-flash');
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
  if (!apiKey) throw new Error('No API key. Set it in the extension popup.');

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
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 65536 }
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

function stripCodeFences(text) {
  text = text.trim();
  if (text.startsWith('```json')) text = text.slice(7);
  else if (text.startsWith('```')) text = text.slice(3);
  if (text.endsWith('```')) text = text.slice(0, -3);
  return text.trim();
}

function extractOriginalFromTruncated(text) {
  const match = text.match(/"original"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  const raw = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return sanitizeTranscription(raw);
}

function parseBreakdownResponse(responseText) {
  const text = stripCodeFences(responseText);

  try {
    const breakdown = JSON.parse(text);
    if (!breakdown.original && breakdown.original !== '') {
      throw new Error('Missing original field');
    }
    if (!Array.isArray(breakdown.words)) {
      throw new Error('Missing words array');
    }
    breakdown.original = sanitizeTranscription(breakdown.original);
    return breakdown;
  } catch (e) {
    // Try to extract the original text from truncated JSON
    const original = extractOriginalFromTruncated(text);
    if (original) {
      return { original, translation: '', words: [], truncated: true };
    }
    throw e;
  }
}

async function analyzeAudioWithGemini(base64Audio, mimeType) {
  if (!apiKey) throw new Error('No API key. Set it in the extension popup.');

  const prompt = `Listen to this Japanese audio and return ONLY valid JSON (no markdown, no code blocks, no explanation):
{
  "original": "the transcribed Japanese text",
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
- If no Japanese speech is detected, return {"original": "", "translation": "", "words": []}
- Do NOT include timestamps, timecodes, or time references (00:00, 00時00分) from audio metadata — only transcribe spoken words
- All text must be readable Japanese/English characters — never output raw byte sequences or hex codes
- Break down ALL words including particles (は, が, を, に, etc.)
- For particles, use their grammatical function as english (e.g., "topic marker", "subject marker", "object marker")
- Keep word order matching the original sentence
- Use lowercase for romaji except for proper nouns
- For verbs, include the conjugated form as it appears`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Audio
              }
            },
            { text: prompt }
          ]
        }],
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
    throw new Error(error.error?.message || 'Audio analysis failed');
  }

  const data = await response.json();
  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  const usageMetadata = data.usageMetadata;
  if (usageMetadata?.totalTokenCount) {
    updateTokenUsage(usageMetadata.totalTokenCount);
  }

  if (!responseText) {
    const blockReason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Audio blocked: ${blockReason}` : 'No audio analysis returned — try shorter segments');
  }

  const finishReason = data.candidates?.[0]?.finishReason;
  const breakdown = parseBreakdownResponse(responseText);

  // If truncated (MAX_TOKENS or partial JSON), re-analyze the transcribed text via chunking
  if ((finishReason === 'MAX_TOKENS' || breakdown.truncated) && breakdown.original) {
    return analyzeJapaneseChunked(breakdown.original);
  }

  return breakdown;
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
}

// ============================================
// Audio level indicator
// ============================================

function updateAudioLevel() {
  if (!isListening) {
    audioLevelBar.style.width = '0%';
    segmentTimerEl.textContent = '';
    return;
  }

  transcriptPlaceholder.style.display = 'none';
  const pct = Math.min(100, (currentRMS / 80) * 100);
  audioLevelBar.style.width = pct + '%';

  if (segmentStart) {
    const elapsed = ((Date.now() - segmentStart) / 1000).toFixed(1);
    segmentTimerEl.textContent = elapsed + 's';
  }
}

// ============================================
// Card rendering
// ============================================

function createBreakdownCard(breakdown, originalText) {
  const card = document.createElement('div');
  card.className = 'segment-card';

  const timestamp = document.createElement('div');
  timestamp.className = 'segment-timestamp';
  timestamp.textContent = new Date().toLocaleTimeString();
  card.appendChild(timestamp);

  const original = document.createElement('div');
  original.className = 'segment-original';
  original.textContent = originalText;
  card.appendChild(original);

  const wrapper = document.createElement('div');
  wrapper.className = 'breakdown-wrapper';

  breakdown.words.forEach(word => {
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
    wrapper.appendChild(block);
  });

  card.appendChild(wrapper);

  const translationDiv = document.createElement('div');
  translationDiv.className = 'breakdown-translation';
  translationDiv.textContent = `"${breakdown.translation}"`;
  card.appendChild(translationDiv);

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
  loading.textContent = 'Transcribing & analyzing...';
  loading.style.color = '#9CA3AF';
  loading.style.fontSize = '13px';
  loading.style.fontStyle = 'italic';
  card.appendChild(loading);

  return card;
}

function createErrorCard(label, error) {
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

  return card;
}

// ============================================
// Audio analysis pipeline
// ============================================

async function processAudioSegment(blob) {
  const durationLabel = ((Date.now() - (segmentStart || Date.now())) / 1000).toFixed(1) + 's audio';

  historyEmpty.style.display = 'none';
  const pendingCard = createPendingCard(durationLabel);
  historyContainer.insertBefore(pendingCard, historyContainer.firstChild);

  try {
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );

    const breakdown = await analyzeAudioWithGemini(base64, 'audio/webm;codecs=opus');

    pendingCard.remove();

    // Empty response means no speech detected — discard silently
    if (!breakdown.original || breakdown.original.trim() === '') {
      return;
    }

    const breakdownCard = createBreakdownCard(breakdown, breakdown.original);
    historyContainer.insertBefore(breakdownCard, historyContainer.firstChild);

    recordWordFrequencies(breakdown.words);

    accumulatedTranscript += breakdown.original + ' ';
    if (isListening) {
      analyzeNowBtn.disabled = false;
    }

    segmentCount++;
    wordCount += breakdown.words.length;
    segmentsProcessedEl.textContent = segmentCount;
    wordsAnalyzedEl.textContent = wordCount;
  } catch (error) {
    pendingCard.remove();
    const errorCard = createErrorCard(durationLabel, error.message);
    historyContainer.insertBefore(errorCard, historyContainer.firstChild);
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
    segmentsProcessedEl.textContent = segmentCount;
    wordsAnalyzedEl.textContent = wordCount;
  } catch (error) {
    pendingCard.remove();
    const errorCard = createErrorCard(text, error.message);
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

silenceSlider.addEventListener('input', () => {
  const val = parseFloat(silenceSlider.value);
  silenceThreshold = val * 1000;
  silenceValue.textContent = val + 's';
});

// Listen for storage changes (user sets API key while page is open)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (changes.geminiApiKey) {
      apiKey = changes.geminiApiKey.newValue || null;
      warningNoKey.style.display = apiKey ? 'none' : 'block';
    }
    if (changes.geminiModel) {
      modelId = changes.geminiModel.newValue || 'gemini-2.5-flash';
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
