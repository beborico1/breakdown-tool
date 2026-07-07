/**
 * Extract all captions from the page
 * @returns {Array<{name: string, message: string}>}
 */
export function extractCaptions() {
  const captions = [];
  const containers = document.querySelectorAll('.nMcdL');

  containers.forEach(container => {
    const nameEl = container.querySelector('.NWpY1d');
    const messageEl = container.querySelector('.ygicle.VbkSUe[data-shadow-original]')
                   || container.querySelector('.ygicle.VbkSUe:not([data-translated])');

    const name = nameEl?.textContent?.trim() || '';
    const message = messageEl?.textContent?.trim() || '';

    // Skip entries with empty messages
    if (message) {
      captions.push({ name, message });
    }
  });

  return captions;
}

/**
 * Format captions as "Name: Message" strings
 * @param {Array<{name: string, message: string}>} captions
 * @returns {string}
 */
export function formatCaptions(captions) {
  return captions
    .map(({ name, message }) => `${name}: ${message}`)
    .join('\n');
}

/**
 * Format session-transcript entries as "Speaker: Text" lines.
 * sessionTranscript uses {speaker, text}; adapt to formatCaptions' {name, message}
 * so the on-clipboard format stays identical.
 * @param {Array<{speaker: string, text: string}>} entries
 * @returns {string}
 */
export function formatTranscriptEntries(entries) {
  return formatCaptions(entries.map(({ speaker, text }) => ({ name: speaker, message: text })));
}
