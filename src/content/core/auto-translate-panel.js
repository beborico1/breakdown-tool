/**
 * Build the shared chevron toggle + collapsible purple translation panel
 * used by both the Chat and Redmine auto lite views.
 *
 * @param {string} translation - The English translation text.
 * @returns {{btn: HTMLButtonElement, panel: HTMLDivElement}}
 */
export function buildTogglePanel(translation) {
  const btn = document.createElement('button');
  btn.className = 'gcwb-auto-translate-toggle';
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('title', 'Show translation');
  btn.textContent = '›';

  const panel = document.createElement('div');
  panel.className = 'gcwb-auto-translation';
  panel.hidden = true;
  const span = document.createElement('span');
  span.className = 'gcwb-translation-text';
  span.textContent = `"${translation}"`;
  panel.appendChild(span);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    if (expanded) {
      btn.setAttribute('aria-expanded', 'false');
      panel.classList.remove('gcwb-auto-translation-open');
      const onEnd = () => {
        if (btn.getAttribute('aria-expanded') === 'false') panel.hidden = true;
        panel.removeEventListener('transitionend', onEnd);
      };
      panel.addEventListener('transitionend', onEnd);
    } else {
      btn.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      void panel.offsetHeight;
      panel.classList.add('gcwb-auto-translation-open');
    }
  });

  return { btn, panel };
}
