import { translateJapanese, warmupNlp } from './api.js';

/**
 * Clause translation for hover.
 *
 * Boundary dots resolve their English when the user hovers them rather than when
 * the block paints. A long article can hold thousands of clauses and the
 * offscreen translator is a single serialized session, so translating eagerly
 * would delay first paint behind work almost none of which is ever read.
 *
 * Results are held for the life of the page only. Persisting them would mean
 * rewriting a whole storage blob per entry, which is the pattern the frequency
 * store was just moved off, for a win that does not outlive a reload.
 */

/** Keeps the map bounded on a page the user scrolls for a long time. */
const MAX_CACHED_CLAUSES = 500;

/** clause text -> English. Insertion-ordered, so the oldest key evicts first. */
const cache = new Map();

/** clause text -> in-flight promise, so two hovers never queue the same work. */
const inFlight = new Map();

/**
 * The translator handles one request at a time, so queueing behind an existing
 * hover keeps a burst of dot hovers from stacking timeouts.
 */
let chain = Promise.resolve();

let warmed = false;

/**
 * Start the tokenizer and translator loading. Called on the first dot hover, not
 * at paint time, so a page that merely contains Japanese does not re-arm the
 * offscreen document and defeat its idle shutdown.
 */
export function warmClauseTranslator() {
  if (warmed) return;
  warmed = true;
  warmupNlp();
}

/**
 * English for one clause, or '' when it cannot be produced.
 * @param {string} clause
 * @returns {Promise<string>}
 */
export function translateClause(clause) {
  const key = (clause || '').trim();
  if (!key) return Promise.resolve('');

  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency so a clause the user keeps returning to survives eviction.
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit);
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = chain.then(() => translateJapanese(key));
  // Keep the chain alive regardless of outcome; translateJapanese already
  // resolves to '' rather than rejecting, this guards a future caller.
  chain = run.catch(() => {});

  const tracked = run
    .then((english) => {
      // Do not cache a failure: the translator may simply have been cold, and a
      // second hover should get a real answer rather than a pinned blank.
      if (english) {
        cache.set(key, english);
        while (cache.size > MAX_CACHED_CLAUSES) {
          cache.delete(cache.keys().next().value);
        }
      }
      return english;
    })
    .catch(() => '')
    .finally(() => { inFlight.delete(key); });

  inFlight.set(key, tracked);
  return tracked;
}

/** Cached English for a clause, or '' when it has not resolved yet. */
export function peekClauseTranslation(clause) {
  return cache.get((clause || '').trim()) || '';
}
