// AudioWorklet that converts captured Float32 audio to 16-bit little-endian PCM
// and posts ~100ms chunks to the main thread, which streams them to the Gemini
// Live API. The AudioContext is created at 16kHz, so no resampling is needed
// here — we only down-convert the sample format.

const TARGET_CHUNK_SAMPLES = 1600; // ~100ms at 16kHz

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(TARGET_CHUNK_SAMPLES);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0]; // mono
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      // Clamp to [-1, 1] and scale to signed 16-bit.
      let s = channel[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      if (this._offset === TARGET_CHUNK_SAMPLES) {
        // Transfer a copy so the underlying buffer can be reused.
        const chunk = this._buffer.slice(0);
        this.port.postMessage(chunk, [chunk.buffer]);
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
