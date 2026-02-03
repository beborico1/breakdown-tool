/**
 * Extract all captions from the page
 * @returns {Array<{name: string, message: string}>}
 */
export function extractCaptions() {
  const captions = [];
  const containers = document.querySelectorAll('.nMcdL');

  containers.forEach(container => {
    const nameEl = container.querySelector('.NWpY1d');
    const messageEl = container.querySelector('.ygicle.VbkSUe[data-translated]')
                   || container.querySelector('.ygicle.VbkSUe');

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
