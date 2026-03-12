// ============================================
// Live Japanese Transcription Page
// Self-contained (no imports) — matches popup.js / frequency.js pattern
// ============================================

// --- DOM refs ---
const micBtn = document.getElementById('micBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const warningNoKey = document.getElementById('warningNoKey');
const warningNoSpeech = document.getElementById('warningNoSpeech');
const silenceSlider = document.getElementById('silenceSlider');
const silenceValue = document.getElementById('silenceValue');
const analyzeNowBtn = document.getElementById('analyzeNow');
const transcriptArea = document.getElementById('transcriptArea');
const transcriptPlaceholder = document.getElementById('transcriptPlaceholder');
const segmentsProcessedEl = document.getElementById('segmentsProcessed');
const wordsAnalyzedEl = document.getElementById('wordsAnalyzed');
const historyContainer = document.getElementById('historyContainer');
const historyEmpty = document.getElementById('historyEmpty');

// --- State ---
let apiKey = null;
let modelId = 'gemini-2.5-flash';
let recognition = null;
let isListening = false;
let isProcessing = false;
let accumulatedText = '';
let silenceTimer = null;
let silenceThreshold = 3000; // ms
let segmentCount = 0;
let wordCount = 0;
let shouldRestart = false;

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
// Transcript buffer
// ============================================

function updateTranscriptDisplay(interimText) {
  transcriptPlaceholder.style.display = 'none';

  // Remove previous interim
  const oldInterim = transcriptArea.querySelector('.transcript-interim');
  if (oldInterim) oldInterim.remove();

  if (interimText) {
    const span = document.createElement('span');
    span.className = 'transcript-interim';
    span.textContent = interimText;
    transcriptArea.appendChild(span);
  }

  transcriptArea.scrollTop = transcriptArea.scrollHeight;
}

function appendFinalTranscript(text) {
  transcriptPlaceholder.style.display = 'none';
  const span = document.createElement('span');
  span.className = 'transcript-final';
  span.textContent = text;
  transcriptArea.appendChild(span);
  transcriptArea.scrollTop = transcriptArea.scrollHeight;
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

function createPendingCard(text) {
  const card = document.createElement('div');
  card.className = 'segment-card pending';

  const timestamp = document.createElement('div');
  timestamp.className = 'segment-timestamp';
  timestamp.textContent = new Date().toLocaleTimeString();
  card.appendChild(timestamp);

  const original = document.createElement('div');
  original.className = 'segment-original';
  original.textContent = text;
  card.appendChild(original);

  const loading = document.createElement('div');
  loading.textContent = 'Analyzing...';
  loading.style.color = '#9CA3AF';
  loading.style.fontSize = '13px';
  loading.style.fontStyle = 'italic';
  card.appendChild(loading);

  return card;
}

function createErrorCard(text, error) {
  const card = document.createElement('div');
  card.className = 'segment-card error';

  const timestamp = document.createElement('div');
  timestamp.className = 'segment-timestamp';
  timestamp.textContent = new Date().toLocaleTimeString();
  card.appendChild(timestamp);

  const original = document.createElement('div');
  original.className = 'segment-original';
  original.textContent = text;
  card.appendChild(original);

  const errorDiv = document.createElement('div');
  errorDiv.className = 'segment-error';
  errorDiv.textContent = error;
  card.appendChild(errorDiv);

  const retryBtn = document.createElement('button');
  retryBtn.className = 'btn-retry';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', () => {
    card.remove();
    sendForAnalysis(text);
  });
  card.appendChild(retryBtn);

  return card;
}

// ============================================
// Analysis pipeline
// ============================================

async function sendForAnalysis(text) {
  if (!text.trim()) return;
  if (isProcessing) return;
  isProcessing = true;

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

  isProcessing = false;
  if (isListening) {
    setStatus('listening', 'Listening...');
    analyzeNowBtn.disabled = accumulatedText.trim().length === 0;
  } else {
    setStatus('ready', 'Ready');
    analyzeNowBtn.disabled = true;
  }
}

// ============================================
// Speech Recognition
// ============================================

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    warningNoSpeech.style.display = 'block';
    micBtn.disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'ja-JP';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        accumulatedText += transcript;
        appendFinalTranscript(transcript);
        analyzeNowBtn.disabled = false;
        resetSilenceTimer();
      } else {
        interim += transcript;
      }
    }
    updateTranscriptDisplay(interim);
  };

  recognition.onend = () => {
    if (shouldRestart && isListening) {
      try {
        recognition.start();
      } catch (e) {
        // Already started
      }
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'no-speech') {
      // Normal — just restart
      return;
    }
    if (event.error === 'not-allowed') {
      setStatus('error', 'Microphone access denied');
      stopListening();
      return;
    }
    if (event.error === 'network') {
      setStatus('error', 'Network error');
      return;
    }
    if (event.error === 'aborted') {
      return;
    }
    setStatus('error', `Error: ${event.error}`);
  };
}

function resetSilenceTimer() {
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    if (accumulatedText.trim()) {
      const text = accumulatedText;
      accumulatedText = '';
      sendForAnalysis(text);
    }
  }, silenceThreshold);
}

function startListening() {
  if (!recognition) return;
  isListening = true;
  shouldRestart = true;
  accumulatedText = '';

  // Clear transcript area for new session
  transcriptArea.querySelectorAll('.transcript-final, .transcript-interim').forEach(el => el.remove());
  transcriptPlaceholder.style.display = '';

  try {
    recognition.start();
  } catch (e) {
    // Already started
  }

  micBtn.classList.add('listening');
  setStatus('listening', 'Listening...');
}

function stopListening() {
  isListening = false;
  shouldRestart = false;

  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {
      // Already stopped
    }
  }

  micBtn.classList.remove('listening');

  // Send remaining text if any
  if (accumulatedText.trim()) {
    const text = accumulatedText;
    accumulatedText = '';
    sendForAnalysis(text);
  } else {
    setStatus('ready', 'Ready');
  }

  analyzeNowBtn.disabled = true;
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
  if (accumulatedText.trim()) {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    const text = accumulatedText;
    accumulatedText = '';
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

  initSpeechRecognition();
}

init();
