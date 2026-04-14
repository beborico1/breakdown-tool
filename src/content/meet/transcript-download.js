import { debugLog } from '../core/debug.js';
import { sessionTranscript } from '../core/state.js';

/**
 * Trigger a client-side download of the accumulated session transcript.
 * Matches the format of the user's manual `transcription.txt`:
 * one Japanese caption per line, each line wrapped in **...**.
 *
 * @param {{ reason?: string }} [opts]
 * @returns {boolean} true if a download was initiated, false if nothing to save
 */
export function triggerTranscriptDownload({ reason = 'manual' } = {}) {
  const lines = sessionTranscript
    .map(entry => entry?.text?.trim())
    .filter(Boolean)
    .map(text => `**${text}**`);

  if (lines.length === 0) {
    debugLog('TRANSCRIPT', `download skipped (reason=${reason}): no captions`);
    return false;
  }

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `meet-transcript-${stamp}.txt`;

  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);

  debugLog('TRANSCRIPT', `download triggered (reason=${reason}, lines=${lines.length}, file=${filename})`);
  return true;
}
