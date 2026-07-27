// The metric registry. Pure data: no imports, no chrome APIs, no logic.
//
// This file is the privacy boundary. The public API takes a metric name, a
// count, and optionally ONE dimension — and every one of those must be a value
// defined here. There is no free-form payload argument anywhere in the API, so
// it is structurally impossible for a URL, a hostname, a page title, a speaker
// name, or any analyzed text to end up in an event. That is enforcement, not a
// convention someone has to remember: the trap is real, since
// core/cache.js generateContentKey() embeds the speaker name and sits one line
// away from the cache hit/miss counters below.

/** Which surface produced the event. The only dimension tied to page context. */
export const S = Object.freeze({
  MEET: 'meet',
  CHAT: 'chat',
  GMAIL: 'gmail',
  REDMINE: 'redmine',
  UNIVERSAL: 'universal',
  PAGE: 'page',
});

/** Why something failed, or which variant of a thing happened. */
export const R = Object.freeze({
  // analyze / NLP failures
  TIMEOUT: 'timeout',
  NORESPONSE: 'noresponse',
  LASTERROR: 'lasterror',
  UNKNOWN: 'unknown',
  // dictionaries
  KUROMOJI: 'kuromoji',
  JMDICT: 'jmdict',
  KANJIDIC: 'kanjidic',
  // on-device translator availability
  UNAVAILABLE: 'unavailable',
  DOWNLOADABLE: 'downloadable',
  DOWNLOADING: 'downloading',
  AVAILABLE: 'available',
  // permissions
  ALLHOSTS: 'allhosts',
  ANKI: 'anki',
  MIC: 'mic',
  // extension pages
  POPUP: 'popup',
  WELCOME: 'welcome',
  FREQUENCY: 'frequency',
  TRANSCRIBE: 'transcribe',
  INSIGHTS: 'insights',
  // exports and transcripts
  JSON: 'json',
  CSV: 'csv',
  ALL: 'all',
  NEW: 'new',
  // anki paths
  QUICKADD: 'quickadd',
  BULK: 'bulk',
});

/**
 * Counters. Each one exists to answer a question in KPIS below; a counter that
 * serves no KPI is noise and should not be added.
 */
export const M = Object.freeze({
  APP_INSTALLED: 'app.installed',
  APP_UPDATED: 'app.updated',
  SESSION_START: 'session.start',

  COLORIZE_BLOCK_OK: 'colorize.block.ok',
  COLORIZE_BLOCK_FAIL: 'colorize.block.fail',
  COLORIZE_BLOCK_STRANDED: 'colorize.block.stranded',
  COLORIZE_WORDS: 'colorize.words',
  PAINT_DRIFT: 'paint.drift',

  ANALYZE_REQ: 'analyze.req',
  ANALYZE_OK: 'analyze.ok',
  ANALYZE_FAIL: 'analyze.fail',
  TOKENIZE_REQ: 'tokenize.req',
  TRANSLATE_REQ: 'translate.req',

  DICT_FAIL: 'dict.fail',
  TRANSLATOR_STATE: 'translator.state',
  OFFSCREEN_CREATE_FAIL: 'offscreen.create_fail',

  HOVER_SHOWN: 'hover.shown',
  BREAKDOWN_OPENED: 'breakdown.opened',

  VOCAB_NEW_WORDS: 'vocab.new_words',
  VOCAB_COUNTED: 'vocab.counted',
  ANKI_CARD_ADDED: 'anki.card.added',
  ANKI_ADD_FAIL: 'anki.add_fail',

  PAGE_OPENED: 'page.opened',
  EXPORT_RUN: 'export.run',
  TRANSCRIPT_COPY: 'transcript.copy',
  TRANSCRIPT_DOWNLOAD: 'transcript.download',
  DICTATION_START: 'dictation.start',

  SETTING_UNIVERSAL_ON: 'setting.universal_on',
  SETTING_UNIVERSAL_OFF: 'setting.universal_off',
  SITE_PAUSED: 'site.paused',
  SITE_RESUMED: 'site.resumed',
  PERM_REQUESTED: 'perm.requested',
  PERM_GRANTED: 'perm.granted',
  PERM_DENIED: 'perm.denied',
});

/** Histogram names, kept separate from their bucket edges so a name is a name. */
export const HN = Object.freeze({
  ANALYZE_MS: 'analyze.ms',
  NLP_ROUNDTRIP_MS: 'nlp.roundtrip.ms',
  FIRST_ANALYZE_MS: 'first_analyze.ms',
});

const LATENCY = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const COLD = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000];

/** name -> ascending bucket edges. One entry per HN value; asserted in tests. */
export const H_EDGES = Object.freeze({
  [HN.ANALYZE_MS]: LATENCY,
  [HN.NLP_ROUNDTRIP_MS]: LATENCY,
  [HN.FIRST_ANALYZE_MS]: COLD,
});

/** Funnel steps. Each records the first timestamp only, and never repeats. */
export const F = Object.freeze({
  INSTALLED: 'installed',
  WELCOME_SEEN: 'welcome_seen',
  FIRST_ANALYZE_ATTEMPT: 'first_analyze_attempt',
  FIRST_COLORIZED_WORD: 'first_colorized_word',
  ALL_SITES_GRANTED: 'all_sites_granted',
  FIRST_HOVER: 'first_hover',
  FIRST_WORD_SAVED: 'first_word_saved',
  FIRST_ANKI_CARD: 'first_anki_card',
});

/**
 * Counters that survive the retention window, so a lifetime total never silently
 * shrinks when old daily buckets are pruned.
 */
export const LIFETIME_KEYS = Object.freeze([
  M.COLORIZE_WORDS, M.COLORIZE_BLOCK_OK, M.COLORIZE_BLOCK_FAIL,
  M.ANALYZE_OK, M.ANALYZE_FAIL, M.HOVER_SHOWN, M.BREAKDOWN_OPENED,
  M.VOCAB_NEW_WORDS, M.VOCAB_COUNTED, M.ANKI_CARD_ADDED, M.SESSION_START,
]);

/**
 * The questions this registry exists to answer. Documented here so a future
 * counter has to justify itself against a KPI rather than being added "in case".
 *
 * ACTIVATION  time to first coloured word (F.FIRST_COLORIZED_WORD - installedAt);
 *             activation rate; all-hosts grant rate (PERM_GRANTED/PERM_REQUESTED
 *             at R.ALLHOSTS); welcome-to-on conversion.
 * ENGAGEMENT  active days; sessions/day; blocks and words coloured per day, split
 *             by surface — the single most decision-relevant number, because it
 *             says whether the value is in the all-sites colorizer or still in Meet;
 *             hovers and breakdowns opened.
 * RETENTION   new vocabulary per day; Anki cards added; dashboard opens; return
 *             days (derived from the day index, needing no event at all).
 * HEALTH      analyze failure rate; stranded blocks (the actionable one — a plain
 *             failure count is dominated by benign cold-start retries); NLP
 *             round-trip latency, cold vs warm; dictionary load failures;
 *             translator availability; offscreen creation failures.
 *
 * Deliberately NOT collected: anything per-URL, per-hostname, per-page-title, or
 * per-word. None of them answer a question above, and all of them would turn an
 * on-device product into one that watches what you read.
 */
