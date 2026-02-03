import { debugLog } from './debug.js';
import { incrementApiCallCount } from './state.js';
import { splitJapaneseText } from '../utils/text.js';

/**
 * Get the Gemini API key from storage
 * @returns {Promise<string|null>}
 */
export async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['geminiApiKey'], (result) => {
      resolve(result.geminiApiKey || null);
    });
  });
}

/**
 * Analyze Japanese text in chunks when the full text causes truncation
 * @param {string} text - Full Japanese text to analyze
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<{original: string, translation: string, words: Array}>}
 */
async function analyzeJapaneseChunked(text, apiKey) {
  debugLog('API-BREAKDOWN', 'Response truncated, retrying with chunks...');

  const chunks = splitJapaneseText(text, 30);
  debugLog('API-BREAKDOWN', `Split into ${chunks.length} chunks:`, chunks);

  const allWords = [];
  let fullTranslation = '';

  for (const chunk of chunks) {
    try {
      const result = await analyzeJapaneseWithGemini(chunk, { noRetry: true });
      if (!result.truncated) {
        allWords.push(...result.words);
        fullTranslation += result.translation + ' ';
      } else {
        // Even smaller chunk still truncated - use as-is
        debugLog('API-BREAKDOWN', `Chunk still truncated: "${chunk.slice(0, 20)}..."`);
        allWords.push({
          japanese: chunk,
          reading: '',
          romaji: chunk,
          english: '[truncated]',
          type: 'expression'
        });
      }
    } catch (error) {
      debugLog('API-BREAKDOWN', `Chunk error for "${chunk.slice(0, 20)}...":`, error.message);
      // Add chunk as unparsed word on error
      allWords.push({
        japanese: chunk,
        reading: '',
        romaji: chunk,
        english: '[error]',
        type: 'expression'
      });
    }
  }

  return {
    original: text,
    translation: fullTranslation.trim(),
    words: allWords
  };
}

/**
 * Analyze Japanese text with Gemini and return structured breakdown
 * @param {string} text - Japanese text to analyze
 * @param {Object} options - Options object
 * @param {boolean} options.noRetry - If true, don't retry with chunking on truncation
 * @returns {Promise<{original: string, translation: string, words: Array<{japanese: string, reading: string, romaji: string, english: string, type: string}>, truncated?: boolean}>}
 */
export async function analyzeJapaneseWithGemini(text, options = {}) {
  const apiKey = await getApiKey();

  if (!apiKey) {
    throw new Error('No API key. Set it in the extension popup.');
  }

  const callNum = incrementApiCallCount();

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

  debugLog('API-BREAKDOWN', `Call #${callNum}`);
  debugLog('API-BREAKDOWN', `INPUT (${text.length} chars):`, text);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 65536,
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json();
    debugLog('API-BREAKDOWN', 'Error response:', error);
    throw new Error(error.error?.message || 'Analysis failed');
  }

  const data = await response.json();
  const finishReason = data.candidates?.[0]?.finishReason;
  let responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  debugLog('API-BREAKDOWN', 'finishReason:', finishReason);
  debugLog('API-BREAKDOWN', 'Response length:', responseText?.length || 0);

  if (!responseText) {
    debugLog('API-BREAKDOWN', 'No response text:', data);
    throw new Error('No analysis returned');
  }

  // Check for truncation before parsing
  if (finishReason === 'MAX_TOKENS') {
    debugLog('API-BREAKDOWN', 'Response end:', responseText.slice(-100));
    if (!options?.noRetry) {
      // Signal to retry with chunking
      return analyzeJapaneseChunked(text, apiKey);
    }
    // In noRetry mode, signal truncation to caller
    return { truncated: true, original: text };
  }

  // Clean up potential markdown code blocks
  responseText = responseText.trim();
  if (responseText.startsWith('```json')) {
    responseText = responseText.slice(7);
  } else if (responseText.startsWith('```')) {
    responseText = responseText.slice(3);
  }
  if (responseText.endsWith('```')) {
    responseText = responseText.slice(0, -3);
  }
  responseText = responseText.trim();

  try {
    const breakdown = JSON.parse(responseText);

    // Validate structure
    if (!breakdown.original || !breakdown.translation || !Array.isArray(breakdown.words)) {
      throw new Error('Invalid breakdown structure');
    }

    debugLog('API-BREAKDOWN', `OUTPUT: ${breakdown.words.length} words parsed`);
    return breakdown;
  } catch (parseError) {
    debugLog('API-BREAKDOWN', 'JSON parse error:', parseError.message);
    debugLog('API-BREAKDOWN', 'Raw response:', responseText.slice(0, 200));
    debugLog('API-BREAKDOWN', 'Response end:', responseText.slice(-100));

    // If JSON parse failed and we haven't retried yet, try chunking
    // (truncation might have occurred even without MAX_TOKENS finishReason)
    if (!options?.noRetry && parseError instanceof SyntaxError) {
      debugLog('API-BREAKDOWN', 'JSON incomplete, attempting chunked retry...');
      return analyzeJapaneseChunked(text, apiKey);
    }

    throw new Error('Failed to parse breakdown response');
  }
}

/**
 * Translate text using Gemini 2.5 Flash
 * @param {string} text - Text to translate
 * @param {Object} options - Translation options
 * @param {string} options.previousTranslation - Previous translation for context (delta mode)
 * @param {boolean} options.isDelta - Whether this is a delta translation
 * @returns {Promise<string>} - Translated text
 */
export async function translateWithGemini(text, options = {}) {
  const apiKey = await getApiKey();

  if (!apiKey) {
    throw new Error('No API key. Set it in the extension popup.');
  }

  const callNum = incrementApiCallCount();

  let prompt;
  if (options.isDelta && options.previousTranslation) {
    // Context-aware delta translation
    const contextSnippet = options.previousTranslation.slice(-50);
    prompt = `Continue this translation. Previous translation ended with: "${contextSnippet}"\n\nTranslate this continuation to English. Only output the translation of the new text, nothing else:\n\n${text}`;
  } else {
    prompt = `Translate the following text to English. Only output the translation, nothing else. If the text is already in English, output it as-is.\n\nText: ${text}`;
  }

  debugLog('API', `Call #${callNum}${options.isDelta ? ' (DELTA)' : ''}`);
  debugLog('API', `INPUT (${text.length} chars):`, text);
  debugLog('API', `FULL PROMPT:`, prompt);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 65536,
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json();
    debugLog('API', 'Error response:', error);
    throw new Error(error.error?.message || 'Translation failed');
  }

  const data = await response.json();
  const translatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!translatedText) {
    debugLog('API', 'No translation in response:', data);
    throw new Error('No translation returned');
  }

  debugLog('API', `OUTPUT (${translatedText.trim().length} chars):`, translatedText.trim());
  return translatedText.trim();
}
