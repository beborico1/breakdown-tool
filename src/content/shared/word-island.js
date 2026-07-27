import { SKIP_SUBTREE_TAGS, isBlockLevel, nearestBlockRoot } from './block-walker.js';
import { count, markOnce } from '../../metrics/index.js';
import { M, F } from '../../metrics/events.js';

/**
 * Word islands: a clicked-together run of coloured words.
 *
 * A word span answers a hover with one word and a clause dot answers with a
 * whole sentence. An island is the rung between them: click a coloured word,
 * click a word touching it, and the run becomes one unit the tooltip can
 * translate. Islands are always contiguous, so clicking a word that touches
 * nothing selected starts over there.
 *
 * "Island" rather than "selection" throughout, because this coexists with the
 * browser's own text selection and must never be mistaken for it: a drag that
 * leaves text selected is explicitly not a click, and copying the page still
 * yields the page's own characters.
 *
 * Chrome-free by design, like the tooltip it feeds, so the DOM test suite can
 * import it straight over http.
 */

const WORD_CLASS = 'gcwb-auto-word';
const BOUNDARY_CLASS = 'gcwb-auto-boundary';
export const ISLAND_CLASS = 'gcwb-island';
const START_CLASS = 'gcwb-island-start';
const END_CLASS = 'gcwb-island-end';

/**
 * Tags that contributed nothing to the analyzer's text AND occupy no visual box
 * between two words, so a walk steps over them as if they were not there. This
 * is what makes fake-furigana sites work: the <sup>つぎ</sup> sitting between two
 * word spans is as invisible to adjacency as it was to tokenization.
 */
const TRANSPARENT_TAGS = new Set([
  'RT', 'RP', 'SUP', 'SUB', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
]);

/** Elements the page's own click belongs to, where a plain click is left alone. */
const INTERACTIVE_SELECTOR =
  'a[href], button, [role="button"], [role="link"], input, select, textarea, ' +
  'label, summary, [contenteditable=""], [contenteditable="true"]';

/**
 * This extension's own in-page surfaces. Clicking one is a question about the
 * text, not a request to throw the island away: reading the machine translation
 * of the paragraph you just built a phrase in must not cost you the phrase.
 */
const EXEMPT_SELECTOR = [
  '.gcwb-ruby-reading', '.gcwb-auto-boundary', '.gcwb-word-tooltip',
  '.gcwb-word-popover', '.gcwb-auto-translate-toggle', '.gcwb-auto-translate-panel',
  '.gcwb-auto-translation', '.gcwb-anki-popover', '.gcwb-anki-toast',
  '.gcwb-context-menu', '.gcwb-inline-container',
].join(', ');

/** How far up to look for a container the site made clickable without semantics. */
const POINTER_ANCESTOR_DEPTH = 8;

/** Bounds one adjacency walk. Two words separated by more markup than this are
 *  not touching by any reading of the word. */
const MAX_WALK_NODES = 60;

/** A word split across more segments than this is markup pathology, not a word. */
const MAX_SEGMENTS = 8;

/** Past this the phrase is a paragraph, and the tooltip is not a reader. */
const MAX_ISLAND_UNITS = 40;

/** Characters allowed between two joined words, after collapsing whitespace. */
const MAX_GAP_CHARS = 8;

/** Widest run the ribbon reaches across. Beyond this the two words are not
 *  visually one thing however the walk scored them. */
const MAX_BRIDGE_PX = 48;

/** Custom property the ribbon reads for how far to reach. */
const BRIDGE_PROPERTY = '--gcwb-island-bridge';

/** Anything with a letter or a digit in it is content, not a separator. */
const GAP_CONTENT_RE = /[\p{L}\p{N}]/u;

/**
 * A sentence stop ends a run. The universal path paints with `marks: 'ja'`, so
 * an ASCII full stop earns no boundary dot and would otherwise slip through the
 * dot barrier.
 */
const GAP_SENTENCE_RE = /[。！？.!?]/;

/** Computed white-space values under which a literal newline is a line break. */
const PRESERVES_NEWLINES_RE = /^(pre|pre-wrap|pre-line|break-spaces|preserve)/;

/** Ordered units, each an array of the spans one analyzer word painted as. */
let units = [];

/** The block every unit resolves to. A different block always restarts. */
let islandScope = null;

/** Bumped on every change, so the memoized phrase cannot outlive its island. */
let generation = 0;
let phraseCache = null;
let phraseGeneration = -1;

/** Injected: called with the span the change came from, or null. */
let notify = null;
let listenersBound = false;

/* ------------------------------------------------------------------ walking */

/**
 * Build the node filter for one walk.
 *
 * `permissive` follows a word's own segments rather than looking for the next
 * word, so it steps over excluded boxes (a `<img>` between the halves of one
 * token) instead of stopping at them: the analyzer joined that word across the
 * box, and the segment id is proof of it.
 *
 * @param {boolean} permissive
 * @returns {{acceptNode: (node: Node) => number}}
 */
function makeFilter(permissive) {
  return {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        // A word span's own characters belong to the word, not to the gap after
        // it, or hopping past a word would fold that word into the separator.
        if (node.parentElement?.classList?.contains(WORD_CLASS)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_REJECT;

      const cl = node.classList;
      if (cl?.contains(WORD_CLASS)) return NodeFilter.FILTER_ACCEPT;
      if (cl?.contains(BOUNDARY_CLASS)) return NodeFilter.FILTER_ACCEPT; // clause edge: stop
      // SVG and MathML elements report tagName in the author's case, so the
      // uppercase sets below would walk straight through an inline icon.
      const tag = node.tagName.toUpperCase();
      if (tag === 'BR') return NodeFilter.FILTER_ACCEPT;                 // hard break: stop
      if (TRANSPARENT_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
      if (node.dataset?.gcwbSkip != null || node.isContentEditable) return NodeFilter.FILTER_ACCEPT;
      if (SKIP_SUBTREE_TAGS.has(tag)) {
        // Excluded but visible. A reader cannot see two words separated by a
        // picture or a code block as one object, so it bounds an island.
        return permissive ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }

      let display = '';
      try { display = getComputedStyle(node).display || ''; } catch { /* keep '' */ }
      if (display === 'none') return NodeFilter.FILTER_REJECT; // hidden: no break
      // No cache: a walker visits each node once, and display is already
      // resolved here and handed over, so there is nothing left to memoize.
      if (isBlockLevel(node, null, display)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP; // an inline wrapper: descend, emit nothing
    }
  };
}

/** True when a literal newline inside `el` renders as a line break. */
function preservesNewlines(el) {
  if (!el) return false;
  try {
    return PRESERVES_NEWLINES_RE.test(getComputedStyle(el).whiteSpace || '');
  } catch {
    return false;
  }
}

/**
 * Step from one word span to the next in reading order, gathering what lies
 * between them.
 *
 * @param {HTMLElement} from
 * @param {Element} scope
 * @param {1|-1} dir
 * @param {boolean} [permissive]
 * @returns {{span: HTMLElement, gap: string, hardBreak: boolean}|null} null when
 *   the walk hit a barrier or ran out of scope.
 */
function hop(from, scope, dir, permissive = false) {
  if (!scope.contains(from)) return null;
  const walker = document.createTreeWalker(
    scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, makeFilter(permissive));
  walker.currentNode = from;

  let gap = '';
  let hardBreak = false;
  for (let steps = 0; steps < MAX_WALK_NODES; steps++) {
    const node = dir > 0 ? walker.nextNode() : walker.previousNode();
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue;
      // A newline is only a break where white-space preserves it. Under the
      // default collapsing, source indentation puts one between almost every
      // pair of words and those must still join.
      if (value.includes('\n') && preservesNewlines(node.parentElement)) hardBreak = true;
      gap = dir > 0 ? gap + value : value + gap;
      continue;
    }
    if (node.classList.contains(WORD_CLASS)) return { span: node, gap, hardBreak };
    return null; // a barrier
  }
  return null;
}

/** Whether what lies between two words is a separator rather than content. */
function gapJoins(gap, hardBreak) {
  if (hardBreak) return false;
  const collapsed = gap.replace(/\s+/g, ' ');
  if (collapsed.length > MAX_GAP_CHARS) return false;
  if (GAP_CONTENT_RE.test(collapsed)) return false;
  return !GAP_SENTENCE_RE.test(collapsed);
}

/** Whether `step` reached `target` across a joinable gap. */
function joins(step, target) {
  return !!step && step.span === target && gapJoins(step.gap, step.hardBreak);
}

/**
 * Every span of the word `span` belongs to, in reading order.
 *
 * A word that straddles text nodes paints as several spans (言 / い / 方 inside
 * fake-furigana markup), and selecting a third of a word reads as broken. The
 * segment id written at paint time is what makes them one unit; its absence is
 * what marks a span as a whole word on its own. Requiring the id on both spans
 * matters: comparing the raw dataset values would match undefined against
 * undefined and fuse every abutting word in a sentence into one unit.
 *
 * @param {HTMLElement} span
 * @param {Element} scope
 * @returns {HTMLElement[]}
 */
function wordUnit(span, scope) {
  const seg = span.dataset.gcwbSeg;
  if (!seg) return [span];

  const unit = [span];
  for (const dir of [-1, 1]) {
    let cursor = span;
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const step = hop(cursor, scope, dir, true);
      if (!step || step.span.dataset.gcwbSeg !== seg) break;
      if (dir < 0) unit.unshift(step.span); else unit.push(step.span);
      cursor = step.span;
    }
  }
  return unit;
}

/* -------------------------------------------------------------- island state */

function spans() {
  const flat = [];
  for (const unit of units) for (const span of unit) flat.push(span);
  return flat;
}

/**
 * Drop the island when the site replaced the DOM under it. Cheap enough to run
 * before every read: an island is at most MAX_ISLAND_UNITS words and isConnected
 * forces no layout.
 * @returns {boolean} whether an island is still live
 */
function ensureLive() {
  if (!units.length) return false;
  for (const unit of units) {
    for (const span of unit) {
      if (!span.isConnected) { commit([], null, null); return false; }
    }
  }
  return true;
}

/**
 * Tell each member how far to reach toward the next one, so the run paints as
 * one ribbon rather than a chip per word.
 *
 * What sits in those gaps is the abut margin and any punctuation the island
 * joined across, both of which are page layout rather than anything this module
 * chose, so the distance has to be measured.
 *
 * Every rect is read before any property is written. Interleaving them would
 * make each write dirty style and each following read force a fresh layout, so
 * a long island would pay one recalc per word.
 *
 * Skipped in vertical writing, where the run advances down the page and a
 * horizontal shadow would reach sideways into the neighbouring column.
 *
 * @param {HTMLElement[]} flat
 */
function paintBridges(flat) {
  if (flat.length < 2) return;
  try {
    if (/vertical|sideways/.test(getComputedStyle(flat[0]).writingMode || '')) return;
  } catch { /* assume horizontal */ }

  const rects = flat.map(span => span.getBoundingClientRect());
  for (let i = 1; i < flat.length; i++) {
    const gap = rects[i].left - rects[i - 1].right;
    // A wrapped run has the next word back at the start of the following line,
    // where a reach would strike out across whatever the page put there.
    const sameLine = Math.abs(rects[i].top - rects[i - 1].top) < 1;
    if (sameLine && gap > 0 && gap <= MAX_BRIDGE_PX) {
      flat[i - 1].style.setProperty(BRIDGE_PROPERTY, `${gap}px`);
    }
  }
}

/**
 * Leave the span exactly as it was found, style attribute and all.
 *
 * The attribute goes rather than the property, because emptying a declaration
 * leaves `style=""` behind: an attribute the page never had, on every word the
 * reader has ever joined. Safe to take wholesale — a word span is built by the
 * token mapper with no inline style, so the only declaration it can carry is
 * the reach set above.
 */
function clearBridge(span) {
  if (span.hasAttribute('style')) span.removeAttribute('style');
}

/** Replace the island, repaint the classes, and announce the change. */
function commit(next, scope, anchor) {
  // The moment a second word joins the first is the gesture worth measuring: it
  // separates reading the colours from actively asking about a chunk. Counting
  // every commit instead would mostly count shrinking and restarting.
  if (next.length === 2 && units.length === 1) {
    count(M.ISLAND_JOINED);
    markOnce(F.FIRST_ISLAND);
  }

  for (const span of spans()) {
    span.classList.remove(ISLAND_CLASS, START_CLASS, END_CLASS);
    clearBridge(span);
  }
  units = next;
  islandScope = next.length ? scope : null;
  generation++;
  phraseCache = null;

  const flat = spans();
  for (const span of flat) span.classList.add(ISLAND_CLASS);
  if (flat.length) {
    flat[0].classList.add(START_CLASS);
    flat[flat.length - 1].classList.add(END_CLASS);
    paintBridges(flat);
  }
  notify?.(anchor);
}

let remeasureFrame = 0;

/**
 * Re-measure the ribbon after a reflow. A resize can rewrap the line the island
 * sits on, which turns a reach across a comma into one striking out across the
 * end of a line.
 *
 * Coalesced into a frame: a window drag delivers resize continuously, and
 * measuring on every one of them would run a layout pass per event for the
 * whole drag. Only ever runs while an island is live.
 */
function onResize() {
  if (units.length < 2 || remeasureFrame) return;
  remeasureFrame = requestAnimationFrame(() => {
    remeasureFrame = 0;
    if (units.length < 2) return;
    const flat = spans();
    for (const span of flat) clearBridge(span);
    paintBridges(flat);
  });
}

/**
 * Drop an island whose page has been navigated out from under it.
 *
 * Without this, an SPA route change leaves the member spans, their detached
 * block, and the scope element reachable from this module for the life of the
 * page, since nothing else reads the island until the next click or hover.
 */
function onSoftNav() {
  ensureLive();
}

/** Which unit holds `span`, or -1. */
function unitIndexOf(span) {
  return units.findIndex(unit => unit.includes(span));
}

/**
 * Apply one click to the island. Exported so a caller that has already decided
 * the click is ours (and the tests) can drive the model without synthesizing a
 * pointer event.
 *
 * @param {HTMLElement} span - a `.gcwb-auto-word` span
 */
export function toggleWordSelection(span) {
  if (!span?.classList?.contains(WORD_CLASS)) return;

  const scope = nearestBlockRoot(span.parentElement || span, new Map());
  const unit = wordUnit(span, scope);

  if (!ensureLive() || islandScope !== scope) {
    commit([unit], scope, span);
    return;
  }

  const idx = unitIndexOf(span);
  if (idx !== -1) {
    if (units.length === 1) commit([], null, span);            // the last word: clear
    else if (idx === 0) commit(units.slice(1), scope, span);   // shrink from the head
    else if (idx === units.length - 1) commit(units.slice(0, -1), scope, span);
    else commit([unit], scope, span);                          // splitting would break contiguity
    return;
  }

  if (units.length >= MAX_ISLAND_UNITS) return; // hold, rather than reset, which reads as a bug

  const tail = units[units.length - 1];
  if (joins(hop(tail[tail.length - 1], scope, 1), unit[0])) {
    commit([...units, unit], scope, span);
    return;
  }

  // Walk back from the island's head to the clicked word's last segment. Walking
  // back from the clicked word instead can never reach a head that lies to its
  // right, which would silently make islands grow rightwards only.
  const head = units[0];
  if (joins(hop(head[0], scope, -1, false), unit[unit.length - 1])) {
    commit([unit, ...units], scope, span);
    return;
  }

  commit([unit], scope, span);
}

/* ----------------------------------------------------------------- accessors */

/**
 * Whether `el` is part of the island. A class read, so it is safe on the
 * document-wide mouseover path.
 * @param {EventTarget|null} el
 * @returns {boolean}
 */
export function isIslandMember(el) {
  return !!el && el.nodeType === Node.ELEMENT_NODE && el.classList.contains(ISLAND_CLASS);
}

/** How many words the island holds. */
export function islandSize() {
  return units.length;
}

/**
 * The island's text, exactly as the page reads it.
 *
 * Assembled from the spans and the gaps between them rather than from
 * `Range.toString()`, which knows nothing of excluded subtrees and would splice
 * every furigana reading into the middle of the phrase, and rather than from
 * `data-word`, which repeats the whole word on each segment of a straddled one.
 * What comes out is a slice of the very string the tokenizer was given.
 *
 * Walking the gaps also revalidates contiguity: if the site edited text between
 * two members, the hop no longer lands and the island is dropped rather than
 * painting one band over a phrase with a hole.
 *
 * @returns {string} '' when there is no island
 */
export function getIslandPhrase() {
  if (!ensureLive()) return '';
  if (phraseGeneration === generation && phraseCache !== null) return phraseCache;

  const flat = spans();
  // Which hops are inside one word. A word's own segments may sit either side of
  // something the analyzer skipped, so those hops have to be permissive; the
  // hops between two words must not be, or an image or a code block dropped
  // between two members after the fact would be walked straight past and the
  // phrase assembled as though nothing had come between them.
  const withinWord = new Set();
  let seen = 0;
  for (const unit of units) {
    for (let i = 1; i < unit.length; i++) withinWord.add(seen + i);
    seen += unit.length;
  }

  let text = flat[0].textContent || '';
  for (let i = 1; i < flat.length; i++) {
    const step = hop(flat[i - 1], islandScope, 1, withinWord.has(i));
    if (!step || step.span !== flat[i]) { commit([], null, null); return ''; }
    text += step.gap + (flat[i].textContent || '');
  }

  phraseCache = text.replace(/\s+/g, ' ').trim();
  phraseGeneration = generation;
  return phraseCache;
}

/**
 * The box the island occupies, for anchoring the tooltip over the whole run
 * rather than the one word under the pointer. Computed fresh: it moves on
 * scroll, and it forces layout, so only call it once a hover is committed.
 * @returns {DOMRect|null}
 */
export function getIslandRect() {
  if (!ensureLive()) return null;
  let box = null;
  for (const span of spans()) {
    const rect = span.getBoundingClientRect();
    if (!box) { box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; continue; }
    box.left = Math.min(box.left, rect.left);
    box.top = Math.min(box.top, rect.top);
    box.right = Math.max(box.right, rect.right);
    box.bottom = Math.max(box.bottom, rect.bottom);
  }
  if (!box) return null;
  return new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
}

/** Drop the island, leaving the page as it was. */
export function clearIsland() {
  if (!units.length) return;
  commit([], null, null);
}

/* ------------------------------------------------------------------ handlers */

/** Whether the page's own click handling owns this word. */
function isInsideInteractive(span) {
  if (span.closest(INTERACTIVE_SELECTOR)) return true;
  // A card the site made clickable with a listener and a cursor, with no
  // semantics to match on. Bounded, because resolving style is the expensive
  // part and a deep tree would pay for all of it on every click.
  let el = span.parentElement;
  for (let i = 0; el && i < POINTER_ANCESTOR_DEPTH; i++, el = el.parentElement) {
    let cursor = '';
    try { cursor = getComputedStyle(el).cursor || ''; } catch { /* keep '' */ }
    if (cursor === 'pointer') return true;
  }
  return false;
}

function onClick(event) {
  if (event.button !== 0) return;
  // A second click of a double-click natively selects the word under it, and a
  // triple-click the paragraph. Neither is a request to build an island.
  if (event.detail !== 1) return;
  // Ctrl and Meta open in a new tab, Shift extends the browser's own selection.
  if (event.ctrlKey || event.metaKey || event.shiftKey) return;
  // A drag that selected text ends in a click too. The leftover selection is
  // what tells them apart.
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed) return;

  const target = event.target;
  if (!target || target.nodeType !== Node.ELEMENT_NODE) return;

  const span = target.closest(`.${WORD_CLASS}`);
  if (!span) {
    // A coloured reading is a sibling of its base word, never a descendant, and
    // it advertises itself with a help cursor. Clicking one is a question about
    // the word, not a request to throw the island away.
    if (!target.closest(EXEMPT_SELECTOR)) clearIsland();
    return;
  }

  // Alt is the way in when the page owns the plain click, so Japanese headlines
  // (almost always links) are still reachable.
  if (!event.altKey && isInsideInteractive(span)) return;

  event.preventDefault();
  event.stopPropagation();
  toggleWordSelection(span);
}

function onKeyDown(event) {
  if (event.key !== 'Escape' || !units.length) return;
  // The event is not consumed. Escape is the page's key as much as ours, and a
  // capture-phase stopPropagation here reaches every listener on the site: a
  // reader with an island open would press it to dismiss a search overlay, lose
  // the island, and still be looking at the overlay.
  clearIsland();
}

/**
 * Bind click-to-join. Idempotent: several surfaces call it and only the first
 * binds, matching setupWordTooltip. The change callback is recorded before that
 * guard so a surface that binds second can still supply one.
 *
 * @param {{onChange?: (anchor: HTMLElement|null) => void}} [options]
 */
export function setupWordIsland(options = {}) {
  if (options.onChange && !notify) notify = options.onChange;
  if (listenersBound) return;
  listenersBound = true;

  // Capture, so the decision to take or leave a click is made before the page
  // acts on it. Clearing hangs off click rather than mousedown because grabbing
  // the scrollbar to read more of a sentence delivers a mousedown too.
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('popstate', onSoftNav);
  window.addEventListener('hashchange', onSoftNav);
}

/**
 * Unbind and forget, leaving the page with no trace of the gesture.
 *
 * Clearing the island alone would not be a teardown: the listeners stay, the
 * words stay painted, and the very next click rebuilds a band on a surface the
 * user has just paused.
 */
export function teardownWordIsland() {
  clearIsland();
  if (remeasureFrame) { cancelAnimationFrame(remeasureFrame); remeasureFrame = 0; }
  if (!listenersBound) return;
  listenersBound = false;
  notify = null;
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('resize', onResize, { passive: true });
  window.removeEventListener('popstate', onSoftNav);
  window.removeEventListener('hashchange', onSoftNav);
}
