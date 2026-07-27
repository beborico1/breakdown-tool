import { debugLog } from '../core/debug.js';
import {
  translationState,
  minimalisticModeEnabled,
  pendingDeltas,
  activeContentKeys,
  wordBlockFontSize,
  OBSERVER_RATE_LIMIT,
  getObserverCallCount,
  getObserverCallWindowStart,
  incrementObserverCallCount,
  resetObserverCallCount,
  sessionTranscript,
  containerToTranscriptIndex,
  transcriptOrphans,
  TRANSCRIPT_REATTACH_WINDOW_MS
} from '../core/state.js';
import { findCachedTranslation } from '../core/cache.js';
import { getCachedWordBreakdown } from '../core/word-cache.js';
import { hideOriginalElement } from '../utils/dom.js';
import { renderBreakdownPanel, applyFontSizeToWrapper } from './panel-mode.js';
import {
  paintWordColoring,
  initializeMinimalisticIncremental,
  handleMinimalisticIncrementalUpdate,
  repaintIncremental,
} from './minimalistic-mode.js';
import { updateBreakdownDelta } from './panel-mode.js';
import { getWordTypeClass } from '../utils/text.js';
import { updateVisualDelta, classifyTextChange } from './delta-translation.js';
import { handleCaptionClick } from './caption-handler.js';
import { handleAnkiContextMenu } from '../chat/anki-quick-add.js';
import { autoProcessPreviousCard } from './auto-processor.js';
import { initializeSentenceProcessing, handleSentenceTextUpdate } from './sentence-processor.js';

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

// We disconnect the observer while mutating the DOM ourselves so our own edits
// don't re-trigger the handler. This module-level flag lets handleMutations
// re-attach the observer from a `finally`, even when a fight-loop op throws —
// otherwise one stray exception would leave the observer permanently
// disconnected and every future caption stuck gray until a page reload.
let observerSuspended = false;

function suspendObserver() {
  if (observerSuspended) return;
  observer.disconnect();
  observerSuspended = true;
}

function resumeObserver(observerConfig) {
  if (!observerSuspended) return;
  observer.observe(document.body, observerConfig);
  observerSuspended = false;
}

/**
 * Cancel any pending debounce/settle timers held on a container's state so they
 * don't fire against a container that has been removed from the DOM.
 */
function cleanupContainerTimers(state) {
  const ms = state?.minimalisticIncrementalState;
  if (ms?.debounceTimer) clearTimeout(ms.debounceTimer);
  if (ms?.settleTimer) clearTimeout(ms.settleTimer);
  if (state?.sentenceState?.debounceTimer) clearTimeout(state.sentenceState.debounceTimer);
}

/**
 * Free per-container resources before dropping its translation state: release the
 * active content key (so pruneTranslationCache can reclaim the cache entry instead
 * of leaking it for the whole session) and cancel pending timers.
 */
function cleanupContainerState(container) {
  const state = translationState.get(container);
  if (!state) return;
  cleanupContainerTimers(state);
  if (state.contentKey) activeContentKeys.delete(state.contentKey);
}

/**
 * Stash a removed caption's transcript index so a replacement element Meet
 * swaps in mid-utterance can reattach to the same entry instead of creating a
 * duplicate. No-op for containers we never recorded.
 * @param {HTMLElement} el
 */
function stashTranscriptOrphan(el) {
  if (!containerToTranscriptIndex.has(el)) return;
  const index = containerToTranscriptIndex.get(el);
  const entry = sessionTranscript[index];
  if (!entry) return;
  transcriptOrphans.push({ index, text: entry.text, speaker: entry.speaker, removedAt: Date.now() });
}

/**
 * Find a recently-removed transcript entry that `text` purely continues (same
 * speaker, new text starts with the removed text) within the reattach window.
 * Rejects corrections/unrelated text, so legitimately-repeated phrases (which
 * arrive in still-present containers and are never orphaned) are never merged.
 * Prunes expired orphans on the way; consumes the match (one-shot).
 * @param {string} speaker
 * @param {string} text
 * @returns {number|null} transcript index to reattach to, or null
 */
function takeOrphanMatch(speaker, text) {
  const now = Date.now();
  for (let i = transcriptOrphans.length - 1; i >= 0; i--) {
    const o = transcriptOrphans[i];
    if (now - o.removedAt > TRANSCRIPT_REATTACH_WINDOW_MS) {
      transcriptOrphans.splice(i, 1);
      continue;
    }
    if (o.speaker !== speaker) continue;
    const change = classifyTextChange(o.text, text);
    if (change.type === 'append' || change.type === 'none') {
      transcriptOrphans.splice(i, 1);
      return o.index;
    }
  }
  return null;
}

/**
 * Record (or update) a caption in the session transcript.
 * Called liberally — each caption container is keyed via WeakMap so
 * subsequent updates to the same container overwrite its entry rather
 * than appending a duplicate.
 * @param {HTMLElement} container
 */
export function recordCaptionToTranscript(container) {
  if (!container || !container.classList?.contains('nMcdL')) return;

  const nameEl = container.querySelector('.NWpY1d');
  const messageEl = container.querySelector('.ygicle.VbkSUe[data-shadow-original]')
                 || container.querySelector('.ygicle.VbkSUe:not([data-translated])');
  if (!messageEl) return;

  const text = messageEl.textContent?.trim() || '';
  if (!text) return;

  const speaker = nameEl?.textContent?.trim() || '';

  if (containerToTranscriptIndex.has(container)) {
    const idx = containerToTranscriptIndex.get(container);
    const entry = sessionTranscript[idx];
    if (entry) {
      entry.text = text;
      if (speaker) entry.speaker = speaker;
    }
  } else {
    const reattachIndex = takeOrphanMatch(speaker, text);
    if (reattachIndex !== null && sessionTranscript[reattachIndex]) {
      // Meet swapped this caption's element mid-utterance; continue the existing
      // entry instead of duplicating it (preserves its copiedLen high-water mark).
      containerToTranscriptIndex.set(container, reattachIndex);
      const entry = sessionTranscript[reattachIndex];
      entry.text = text;
      if (speaker) entry.speaker = speaker;
      debugLog('TRANSCRIPT-REATTACH', `#${reattachIndex}: "${text.slice(0, 40)}"`);
      return;
    }
    const idx = sessionTranscript.length;
    containerToTranscriptIndex.set(container, idx);
    sessionTranscript.push({ speaker, text, firstSeen: Date.now() });
  }
}

/**
 * Setup caption click handlers and auto-apply cached translations
 */
export function setupCaptionClickHandlers() {
  const containers = document.querySelectorAll('.nMcdL:not(.caption-translatable)');

  containers.forEach(container => {
    container.classList.add('caption-translatable');
    container.addEventListener('click', handleCaptionClick);
    container.addEventListener('contextmenu', handleAnkiContextMenu, true);

    // Strip inline max-width that Google Meet may apply (780px cap)
    container.style.removeProperty('max-width');
    if (container.parentElement) {
      container.parentElement.style.removeProperty('max-width');
    }

    const nameEl = container.querySelector('.NWpY1d');
    const messageEl = container.querySelector('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original])');
    const speaker = nameEl?.textContent?.trim() || '(unknown)';
    const originalText = messageEl?.textContent?.trim() || '';

    recordCaptionToTranscript(container);

    debugLog('SETUP', `New container: speaker="${speaker}", text="${originalText.slice(0, 40)}..."`);

    // Auto-apply cached breakdown if this content is actively displayed.
    // Panel-mode only: this re-association path renders the full squared
    // breakdown panel. In minimalistic mode the container is owned by
    // initializeMinimalisticIncremental (live card) / initializeMinimalisticContainer
    // (previous card), so gating it off here keeps recurring short phrases from
    // popping the full panel instead of in-place coloring.
    if (!minimalisticModeEnabled && originalText && messageEl && activeContentKeys.size > 0) {
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

    // Initialize sentence-level processing on the last (current) container.
    // Minimalistic mode gets the in-place incremental painter; otherwise the
    // panel-style sentence processor kicks in.
    const allContainers = document.querySelectorAll('.nMcdL');
    const lastContainer = allContainers[allContainers.length - 1];
    if (lastContainer && !translationState.has(lastContainer)) {
      if (minimalisticModeEnabled) {
        initializeMinimalisticIncremental(lastContainer);
      } else {
        initializeSentenceProcessing(lastContainer);
      }
    }
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

  // Pre-pass: stash the transcript index of any caption container removed in this
  // batch BEFORE we record or sweep, so a replacement element (a Meet mid-utterance
  // DOM swap) inserted in the same batch reattaches instead of duplicating. Must run
  // first: a replacement's characterData record below can otherwise be visited before
  // the removal, pushing a duplicate before the orphan exists.
  for (const mutation of mutations) {
    for (const node of mutation.removedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.classList?.contains('nMcdL')) stashTranscriptOrphan(node);
      const inner = node.querySelectorAll?.('.nMcdL');
      if (inner) {
        for (const el of inner) stashTranscriptOrphan(el);
      }
    }
  }

  let addedCount = 0;
  let removedCount = 0;

  for (const mutation of mutations) {
    // Skip mutations on our own translated elements
    if (mutation.target.hasAttribute?.('data-translated')) continue;

    // Handle characterData mutations for visual delta display (no auto-translation)
    if (mutation.type === 'characterData') {
      // Keep the session transcript in sync whenever any caption's text grows.
      const captionContainer = mutation.target.parentElement?.closest('.nMcdL');
      if (captionContainer) {
        recordCaptionToTranscript(captionContainer);
      }

      // Check if this mutation is inside a shadow original element
      const shadowEl = mutation.target.parentElement?.closest('[data-shadow-original]');
      if (shadowEl) {
        const container = shadowEl.closest('.nMcdL');
        if (container && translationState.has(container)) {
          const state = translationState.get(container);
          if (state.minimalisticIncrementalState) {
            // Eager per-sentence processing on the live minimalistic container.
            handleMinimalisticIncrementalUpdate(container);
          } else if (state.sentenceState) {
            // Handle sentence-level processing text updates
            handleSentenceTextUpdate(container);
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
        cleanupContainerState(node);
        translationState.delete(node);
      }

      // Check for translated containers inside the removed subtree
      const inner = node.querySelectorAll?.('.nMcdL');
      if (inner) {
        for (const el of inner) {
          if (translationState.has(el)) {
            debugLog('MUTATION-REMOVED', 'Translated container removed (nested)');
            cleanupContainerState(el);
            translationState.delete(el);
          }
        }
      }
    }
  }

  // Reconcile removed/stale containers, then fight Meet's re-insertions. Both run
  // with the observer suspended; the try/finally guarantees it is always
  // re-attached, so a throw mid-fight can never permanently wedge caption
  // processing (which would otherwise leave every future caption stuck gray).
  try {
    reconcileStaleContainers();
    fightMeetReinsertions();
  } catch (err) {
    debugLog('FIGHT-ERROR', err?.message || String(err));
  } finally {
    resumeObserver(observerConfig);
  }

  // Wire up any new containers
  setupCaptionClickHandlers();

  // Catch-all: sweep every visible caption so the session transcript
  // captures text changes even when they don't surface as a characterData
  // mutation we routed above (e.g., Meet replacing the text node wholesale).
  for (const container of document.querySelectorAll('.nMcdL')) {
    recordCaptionToTranscript(container);
  }
}

/**
 * Re-associate state for containers Meet removed from the DOM with any new
 * container showing the same cached content; drop state that can't be matched.
 * Suspends the observer (via suspendObserver) before mutating; handleMutations
 * resumes it in a finally.
 */
function reconcileStaleContainers() {
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

            // Suspend the observer during our DOM modification
            suspendObserver();

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
            newContainer.addEventListener('contextmenu', handleAnkiContextMenu, true);

            reassociated = true;
            break;
          }
        }
      }

      if (!reassociated) {
        debugLog('CLEANUP', 'No matching container found, removing state');
        // Not handed off to a new container — free its content key + timers.
        cleanupContainerState(container);
      }

      // Always remove the stale container entry
      translationState.delete(container);
    }
  }
}

/**
 * Fight Meet's re-insertions: re-strip originals, re-insert our elements/panels,
 * re-paint minimalistic coloring, and strip max-width caps. Suspends the observer
 * lazily (on the first mutation) via suspendObserver; handleMutations resumes it.
 */
function fightMeetReinsertions() {
  for (const [container, state] of translationState) {
    // (A) Remove any original caption elements Meet re-inserted
    // BUT keep shadow original elements (they receive text updates)
    // Also keep minimalistic-colored elements (we painted word spans into them)
    const originals = container.querySelectorAll('.ygicle.VbkSUe:not([data-translated]):not([data-shadow-original]):not([data-mm-colored]):not([data-processing])');
    if (originals.length > 0) {
      suspendObserver();
      for (const orig of originals) {
        orig.remove();
      }
    }

    // (B) Re-insert our element if dislodged
    if (state.translatedEl && !container.contains(state.translatedEl)) {
      suspendObserver();
      try {
        container.appendChild(state.translatedEl);
      } catch (e) {
        // Meet can reparent caption subtrees so translatedEl is no longer a valid
        // child target (HierarchyRequestError); skip rather than abort the loop.
        debugLog('FIGHT', `appendChild failed: ${e?.message || e}`);
      }
    }

    // (C) Restore text if Meet overwrote it (but NOT if we're in the middle of updating or showing delta)
    // Skip for minimalistic mode (it uses innerHTML with spans, not textContent)
    // Skip this check if the element has data-updating or data-has-delta attribute
    if (!state.minimalisticState && !state.sentenceState && !state.breakdownData && state.translatedText && state.translatedEl &&
        !state.translatedEl.hasAttribute('data-updating') &&
        !state.translatedEl.hasAttribute('data-has-delta') &&
        state.translatedEl.textContent !== state.translatedText) {
      suspendObserver();
      state.translatedEl.textContent = state.translatedText;
    }

    // (D) Re-insert breakdown panel if dislodged (only for panel mode, not minimalistic)
    if (!state.minimalisticState && !state.sentenceState && state.breakdownData && !container.querySelector('.breakdown-wrapper:not([data-sentence-mode])')) {
      suspendObserver();
      renderBreakdownPanel(container, state.breakdownData, state.speakerName, state.isExpanded);
    }

    // (D2) Re-insert sentence-mode wrapper if dislodged
    if (state.sentenceState && !container.querySelector('.breakdown-wrapper[data-sentence-mode]')) {
      suspendObserver();
      // Rebuild the sentence wrapper from processed state
      rebuildSentenceWrapper(container, state);
    }

    // (E) Re-paint minimalistic word coloring if Meet stripped our spans.
    // Falls back to the persistent word cache while the analyzer is still in-flight,
    // so pre-painted captions don't fade to white on the first Meet rebuild.
    if (state.minimalisticState && state.shadowOriginalEl && state.originalText) {
      const el = state.shadowOriginalEl;
      if (el.hasAttribute('data-mm-colored') && !el.querySelector('.mm-word')) {
        const words = state.breakdownData?.words
          || getCachedWordBreakdown(state.originalText);
        if (words.length > 0) {
          suspendObserver();
          const sents = state.breakdownData
            ? [{
                text: state.originalText,
                startIndex: 0,
                endIndex: state.originalText.length,
                breakdownData: state.breakdownData,
              }]
            : null;
          paintWordColoring(el, state.originalText, words, sents);
        }
      }
    }

    // (E2) Same as (E) but for the live incremental painter.
    if (state.minimalisticIncrementalState && state.shadowOriginalEl) {
      const el = state.shadowOriginalEl;
      if (el.hasAttribute('data-mm-colored') && !el.querySelector('.mm-word')) {
        suspendObserver();
        repaintIncremental(container);
      }
    }

    // (F) Strip inline max-width that Meet may re-apply (780px cap)
    if (container.style.maxWidth) {
      suspendObserver();
      container.style.removeProperty('max-width');
    }
    if (container.parentElement?.style.maxWidth) {
      suspendObserver();
      container.parentElement.style.removeProperty('max-width');
    }
  }
}

/**
 * Rebuild a sentence-mode wrapper from stored state when Meet dislodges it
 * @param {HTMLElement} container
 * @param {Object} state - Translation state for the container
 */
function rebuildSentenceWrapper(container, state) {
  const ss = state.sentenceState;

  const wrapper = document.createElement('div');
  wrapper.className = 'breakdown-wrapper';
  wrapper.setAttribute('data-sentence-mode', 'true');
  wrapper.setAttribute('data-expanded', state.isExpanded ? 'true' : 'false');

  // Re-render all processed sentences
  for (const sentence of ss.processedSentences) {
    const group = document.createElement('div');
    group.className = 'sentence-group';

    (sentence.breakdownData?.words || []).forEach(word => {
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
      group.appendChild(block);
    });

    const translationDiv = document.createElement('div');
    translationDiv.className = 'breakdown-translation';
    translationDiv.textContent = `"${sentence.breakdownData?.translation || ''}"`;
    group.appendChild(translationDiv);

    wrapper.appendChild(group);
  }

  // Re-add live text
  const liveTextDiv = document.createElement('div');
  liveTextDiv.className = 'sentence-live-text';
  const pendingText = ss.fullText.slice(ss.lastProcessedIndex).trim();
  liveTextDiv.textContent = pendingText;
  liveTextDiv.style.display = pendingText ? '' : 'none';
  wrapper.appendChild(liveTextDiv);

  applyFontSizeToWrapper(wrapper, wordBlockFontSize);
  container.appendChild(wrapper);
}
