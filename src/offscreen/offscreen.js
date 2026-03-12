/**
 * Offscreen Document for Audio Capture
 * Captures tab audio stream, detects silence boundaries, and sends audio segments
 * to the service worker for transcription.
 */

const SILENCE_THRESHOLD = 15;      // RMS volume below this = silence (0-255 scale)
const SILENCE_DURATION = 1500;     // ms of silence to trigger segment boundary
const MIN_SEGMENT_DURATION = 1000; // Minimum segment length in ms
const MAX_SEGMENT_DURATION = 15000; // Maximum segment length in ms

let mediaStream = null;
let audioContext = null;
let analyser = null;
let mediaRecorder = null;
let recordedChunks = [];
let silenceStart = null;
let segmentStart = null;
let isRecording = false;
let silenceCheckInterval = null;

/**
 * Start capturing audio from the tab stream
 */
async function startCapture(streamId) {
  try {
    // Get the media stream using the stream ID from tabCapture
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    // Set up AudioContext for silence detection
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyserNode();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);

    // Start recording
    startNewRecording();

    // Start silence detection loop
    silenceCheckInterval = setInterval(checkSilence, 100);

    console.log('[Offscreen] Audio capture started');
  } catch (error) {
    console.error('[Offscreen] Failed to start capture:', error);
  }
}

/**
 * Start a new MediaRecorder segment
 */
function startNewRecording() {
  recordedChunks = [];
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
      const blob = new Blob(recordedChunks, { type: 'audio/webm;codecs=opus' });
      sendAudioSegment(blob);
    }
  };

  mediaRecorder.start(100); // Collect data every 100ms
  isRecording = true;
  silenceStart = null;
}

/**
 * Check audio levels for silence detection
 */
function checkSilence() {
  if (!analyser || !isRecording) return;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(dataArray);

  // Calculate RMS volume
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const val = (dataArray[i] - 128) / 128;
    sum += val * val;
  }
  const rms = Math.sqrt(sum / dataArray.length) * 255;

  const now = Date.now();
  const segmentDuration = now - segmentStart;

  // Force segment boundary at max duration
  if (segmentDuration >= MAX_SEGMENT_DURATION) {
    finalizeSegment();
    return;
  }

  if (rms < SILENCE_THRESHOLD) {
    // In silence
    if (!silenceStart) {
      silenceStart = now;
    } else if (now - silenceStart >= SILENCE_DURATION && segmentDuration >= MIN_SEGMENT_DURATION) {
      // Silence boundary detected - finalize segment
      finalizeSegment();
    }
  } else {
    // Sound detected - reset silence timer
    silenceStart = null;
  }
}

/**
 * Finalize current segment and start a new one
 */
function finalizeSegment() {
  if (!isRecording || !mediaRecorder || mediaRecorder.state !== 'recording') return;

  mediaRecorder.stop();
  isRecording = false;

  // Start new recording immediately
  setTimeout(() => {
    if (mediaStream && mediaStream.active) {
      startNewRecording();
    }
  }, 50);
}

/**
 * Convert blob to base64 and send to service worker
 */
async function sendAudioSegment(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );

    chrome.runtime.sendMessage({
      type: 'audio-segment',
      audio: base64,
      mimeType: 'audio/webm;codecs=opus'
    });
  } catch (error) {
    console.error('[Offscreen] Failed to send segment:', error);
  }
}

/**
 * Stop capture and clean up
 */
function stopCapture() {
  if (silenceCheckInterval) {
    clearInterval(silenceCheckInterval);
    silenceCheckInterval = null;
  }

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  isRecording = false;

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  analyser = null;
  mediaRecorder = null;
  recordedChunks = [];

  console.log('[Offscreen] Audio capture stopped');
}

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'offscreen-start-capture') {
    startCapture(message.streamId);
  }

  if (message.type === 'offscreen-stop-capture') {
    stopCapture();
  }
});
