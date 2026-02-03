import { debugLog } from '../core/debug.js';
import {
  translationState,
  pendingDeltas,
  activeContentKeys,
  OBSERVER_RATE_LIMIT,
  getObserverCallCount,
  getObserverCallWindowStart,
  incrementObserverCallCount,
  resetObserverCallCount
} from '../core/state.js';
import { findCachedTranslation } from '../core/cache.js';
import { hideOriginalElement } from '../utils/dom.js';
import { renderBreakdownPanel } from './panel-mode.js';
import { renderMinimalisticCaption, handleMinimalisticTextUpdate } from './minimalistic-mode.js';
import { updateBreakdownDelta } from './panel-mode.js';
import { updateVisualDelta } from './delta-translation.js';
import { handleCaptionClick } from './caption-handler.js';
import { autoProcessPreviousCard } from './auto-processor.js';

// Observer reference (will be set when created)
let observer = null;

/**
 * Set the observer reference for reconnection
 * @param {MutationObserver} obs
 */
export function setObserver(obs) {
  observer = obs;
}

/**
 * Get the observer reference
 * @returns {MutationObserver}
 */
export function getObserver() {
  return observer;
}

/**
 * Setup caption click handlers and auto-apply cached translations
 */
export function setupCaptionClickHandlers() {
  const containers = document.querySelectorAll('.nMcdL:not(.caption-translatable)');

  containers.forEach(container => {
    container.classList.add('caption-translatable');
    container.addEventListener('click', handleCaptionClick);

    const nameEl = container.querySelector('.NWpY1d');
    const messageEl = container.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original])');
    const speaker = nameEl?.textContent?.trim() || '(unknown)';
    const originalText = messageEl?.textContent?.trim() || '';

    debugLog('SETUP', `New container: speaker="${speaker}", text="${originalText.slice(0, 40)}..."`);

    // Auto-apply cached breakdown if this content is actively displayed
    if (originalText && messageEl && activeContentKeys.size > 0) {
      const cached = findCachedTranslation(speaker, originalText);
      if (cached && activeContentKeys.has(cached.contentKey)) {
        debugLog('AUTO-APPLY', `Re-applying breakdown to new container: ${originalText.slice(0, 40)}`);

        // Create translated element (hidden placeholder)
        const translatedEl = document.createElement('div');
        translatedEl.className = messageEl.className;
        translatedEl.setAttribute('data-translated', 'true');
        translatedEl.style.display = 'none';

        // Use shadow element approach
        hideOriginalElement(messageEl);
        messageEl.insertAdjacentElement('afterend', translatedEl);

        // Clone original for fallback restoration
        const originalEl = messageEl.cloneNode(true);
        originalEl.style.cssText = '';
        originalEl.removeAttribute('data-shadow-original');

        // Store state for the new container with breakdown data
        translationState.set(container, {
          originalText,
          originalEl,
          translatedText: cached.translatedText,
          translatedEl,
          contentKey: cached.contentKey,
          lastTranslatedLength: originalText.length,
          shadowOriginalEl: messageEl,
          speakerName: speaker,
          isIncremental: false,
          breakdownData: cached.breakdownData || null,
          isExpanded: true
        });

        // Render breakdown panel if we have data
        if (cached.breakdownData) {
          renderBreakdownPanel(container, cached.breakdownData, speaker);
        }
      }
    }
  });

  // Auto-process the previous card when new containers are added
  if (containers.length > 0) {
    autoProcessPreviousCard();
  }
}

/**
 * Handle mutations from the observer
 * @param {MutationRecord[]} mutations
 * @param {Object} observerConfig
 */
export function handleMutations(mutations, observerConfig) {
  // Rate-limit detection
  incrementObserverCallCount();
  const now = Date.now();
  const elapsed = now - getObserverCallWindowStart();

  if (elapsed >= 1000) {
    if (getObserverCallCount() > OBSERVER_RATE_LIMIT) {
      debugLog('LOOP-DETECT', `Observer fired ${getObserverCallCount()} times in ${elapsed}ms — possible infinite loop!`);
    }
    resetObserverCallCount();
  }

  let addedCount = 0;
  let removedCount = 0;

  for (const mutation of mutations) {
    // Skip mutations on our own translated elements
    if (mutation.target.hasAttribute?.('data-translated')) continue;

    // Handle characterData mutations for visual delta display (no auto-translation)
    if (mutation.type === 'characterData') {
      // Check if this mutation is inside a shadow original element
      const shadowEl = mutation.target.parentElement?.closest('[data-shadow-original]');
      if (shadowEl) {
        const container = shadowEl.closest('.nMcdL');
        if (container && translationState.has(container)) {
          const state = translationState.get(container);
          if (state.minimalisticState) {
            // Handle minimalistic mode text updates
            const newText = shadowEl.textContent?.trim() || '';
            handleMinimalisticTextUpdate(container, newText);
          } else if (state.breakdownData) {
            // Show new text in breakdown panel without processing
            updateBreakdownDelta(container);
          } else if (state.isIncremental) {
            // Only update visual display - user must click to translate
            updateVisualDelta(container);
          }
        }
      }
    }

    addedCount += mutation.addedNodes.length;
    removedCount += mutation.removedNodes.length;

    // Check if any removed nodes contain translated containers
    for (const node of mutation.removedNodes) {
      if (!(node instanceof HTMLElement)) continue;

      // Check if the removed node itself is a translated container
      if (node.classList?.contains('nMcdL') && translationState.has(node)) {
        debugLog('MUTATION-REMOVED', 'Translated container removed from DOM');
        translationState.delete(node);
      }

      // Check for translated containers inside the removed subtree
      const inner = node.querySelectorAll?.('.nMcdL');
      if (inner) {
        for (const el of inner) {
          if (translationState.has(el)) {
            debugLog('MUTATION-REMOVED', 'Translated container removed (nested)');
            translationState.delete(el);
          }
        }
      }
    }
  }

  // Clean up stale state: containers no longer in DOM
  // Try to re-associate with new containers that have matching content
  for (const [container, state] of translationState) {
    if (!document.body.contains(container)) {
      debugLog('CLEANUP', 'Stale container detected, attempting re-association');

      // Cancel any pending delta translations for this container
      const pendingTimeout = pendingDeltas.get(container);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingDeltas.delete(container);
      }

      // Try to find a new container with matching content
      let reassociated = false;
      if (state.contentKey && state.translatedText) {
        const allContainers = document.querySelectorAll('.nMcdL');
        for (const newContainer of allContainers) {
          // Skip if already has translation state
          if (translationState.has(newContainer)) continue;

          const nameEl = newContainer.querySelector('.NWpY1d');
          const messageEl = newContainer.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original])');
          const speaker = nameEl?.textContent?.trim() || '(unknown)';
          const text = messageEl?.textContent?.trim() || '';

          if (!text || !messageEl) continue;

          // Check if content matches
          const cached = findCachedTranslation(speaker, text);
          if (cached && cached.contentKey === state.contentKey) {
            debugLog('REASSOC', `Found matching container for: ${text.slice(0, 40)}`);

            // Create new translated element
            const translatedEl = document.createElement('div');
            translatedEl.className = messageEl.className;
            translatedEl.setAttribute('data-translated', 'true');
            translatedEl.textContent = state.translatedText;

            // Disconnect observer during our DOM modification
            observer.disconnect();

            // Use shadow element approach for incremental tracking
            hideOriginalElement(messageEl);
            messageEl.insertAdjacentElement('afterend', translatedEl);

            // Clone original for fallback restoration
            const originalEl = messageEl.cloneNode(true);
            originalEl.style.cssText = '';
            originalEl.removeAttribute('data-shadow-original');

            // Store state for the new container with incremental tracking
            translationState.set(newContainer, {
              originalText: text,
              originalEl,
              translatedText: state.translatedText,
              translatedEl,
              contentKey: state.contentKey,
              lastTranslatedLength: text.length,
              shadowOriginalEl: messageEl,
              speakerName: speaker,
              isIncremental: true
            });

            // Mark new container as translatable
            newContainer.classList.add('caption-translatable');
            newContainer.addEventListener('click', handleCaptionClick);

            // Reconnect observer
            observer.observe(document.body, observerConfig);

            reassociated = true;
            break;
          }
        }
      }

      if (!reassociated) {
        debugLog('CLEANUP', 'No matching container found, removing state');
      }

      // Always remove the stale container entry
      translationState.delete(container);
    }
  }

  // Fight Meet re-insertions: protect translated containers
  // Disconnect observer lazily to prevent infinite loop from our own DOM modifications
  let didFight = false;

  for (const [container, state] of translationState) {
    // (A) Remove any original caption elements Meet re-inserted
    // BUT keep shadow original elements (they receive text updates)
    // Also keep mm-display elements for minimalistic mode
    const originals = container.querySelectorAll('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original]):not([data-mm-display])');
    if (originals.length > 0) {
      if (!didFight) { observer.disconnect(); didFight = true; }
      for (const orig of originals) {
        orig.remove();
      }
    }

    // (B) Re-insert our element if dislodged
    if (state.translatedEl && !container.contains(state.translatedEl)) {
      if (!didFight) { observer.disconnect(); didFight = true; }
      container.appendChild(state.translatedEl);
    }

    // (C) Restore text if Meet overwrote it (but NOT if we're in the middle of updating or showing delta)
    // Skip for minimalistic mode (it uses innerHTML with spans, not textContent)
    // Skip this check if the element has data-updating or data-has-delta attribute
    if (!state.minimalisticState && state.translatedText && state.translatedEl &&
        !state.translatedEl.hasAttribute('data-updating') &&
        !state.translatedEl.hasAttribute('data-has-delta') &&
        state.translatedEl.textContent !== state.translatedText) {
      if (!didFight) { observer.disconnect(); didFight = true; }
      state.translatedEl.textContent = state.translatedText;
    }

    // (D) Re-insert breakdown panel if dislodged (only for panel mode, not minimalistic)
    if (!state.minimalisticState && state.breakdownData && !container.querySelector('.breakdown-panel')) {
      if (!didFight) { observer.disconnect(); didFight = true; }
      renderBreakdownPanel(container, state.breakdownData, state.speakerName, state.isExpanded);
    }

    // (E) Re-render minimalistic display if needed
    if (state.minimalisticState && state.translatedEl && state.breakdownData) {
      // Check if display element lost its content (Meet might have cleared it)
      if (!state.translatedEl.querySelector('.mm-char')) {
        if (!didFight) { observer.disconnect(); didFight = true; }
        renderMinimalisticCaption(state.translatedEl, state.originalText, state.minimalisticState);
      }
    }
  }

  // Reconnect observer after our DOM modifications are done
  if (didFight) {
    observer.observe(document.body, observerConfig);
  }

  // Wire up any new containers
  setupCaptionClickHandlers();
}
