import { debugLog } from '../core/debug.js';

/**
 * Redmine Page Detection & Text Block Finder
 * Detects Redmine pages and locates Japanese text blocks in the DOM.
 */

// Selectors for analyzable text blocks
const TARGET_SELECTORS = [
  '.subject h3',
  '.description .wiki',
  '.journal .wiki',
  '.wiki-page .wiki',
  '.news .wiki',
  '#activity dd'
];

// Selectors that must never be analyzed (edit forms, inputs)
const EXCLUDE_SELECTORS = [
  'textarea',
  'input',
  'select',
  '.jstEditor',
  '#issue-form',
  '[contenteditable]',
  '.wiki-edit',
  '.contextual'
];

/**
 * Signals that are specific to Redmine rather than to Rails in general.
 * At least one must be present. Ordered cheapest-first.
 */
const REDMINE_FINGERPRINTS = [
  'meta[name="description"][content*="Redmine" i]',
  'link[rel="stylesheet"][href*="/stylesheets/application.css"][href*="redmine" i]',
  '#footer a[href*="redmine.org" i]',
  '#top-menu #account',
  '#main #content #sidebar',
  'a[href$="/my/page"], a[href*="/issues?set_filter="]',
];

/**
 * Detect if the current page is a Redmine instance.
 *
 * `controller-* action-*` on <body> plus an `#wrapper` is a stock Rails idiom, not a
 * Redmine signature, and #wrapper is one of the commonest ids on the web. That was
 * tolerable while a static host match fenced this off, but the all-sites colorizer now
 * runs it on every page — and a false positive is expensive in an asymmetric way:
 * isBuiltInSurface() would return true, silently disabling the colorizer on a site that
 * has nothing to do with Redmine. A false negative only costs the richer Redmine
 * treatment; the page still gets colorized. So require the Rails shape AND a
 * genuinely Redmine-specific marker.
 * @returns {boolean}
 */
export function isRedmine() {
  const body = document.body;
  if (!body) return false;

  // Redmine adds controller-* and action-* classes to <body> — necessary, not sufficient.
  const className = typeof body.className === 'string' ? body.className : '';
  if (!/\bcontroller-\w+/.test(className) || !/\baction-\w+/.test(className)) return false;

  // Redmine's canonical layout wrapper.
  if (!document.getElementById('wrapper') && !document.getElementById('top-menu')) return false;

  return REDMINE_FINGERPRINTS.some((sel) => {
    try {
      return !!document.querySelector(sel);
    } catch {
      return false; // selector unsupported in this engine
    }
  });
}

/**
 * Find the nearest analyzable Redmine text block from a click/hover target.
 * Walks up the DOM to the nearest target selector match.
 * Returns null if the target is inside an excluded selector.
 * @param {HTMLElement} target - Click or hover target element
 * @returns {HTMLElement|null}
 */
export function findRedmineTextElement(target) {
  debugLog('REDMINE-FIND', 'Looking for text element from target:', target.className || target.nodeName);

  // Reject if inside an excluded element
  for (const selector of EXCLUDE_SELECTORS) {
    if (target.closest(selector)) {
      debugLog('REDMINE-FIND', 'Target is inside excluded selector:', selector);
      return null;
    }
  }

  // For targets inside .wiki blocks, prefer the nearest block-level element for focused analysis
  const wikiParent = target.closest('.wiki');
  if (wikiParent) {
    const focusSelectors = ['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'dd', 'dt', 'blockquote'];
    for (const sel of focusSelectors) {
      const el = target.closest(sel);
      if (el && wikiParent.contains(el)) {
        debugLog('REDMINE-FIND', `Found <${sel}> within .wiki block`);
        return el;
      }
    }
    debugLog('REDMINE-FIND', 'Using full .wiki block');
    return wikiParent;
  }

  // Check other target selectors
  for (const selector of TARGET_SELECTORS) {
    const match = target.closest(selector);
    if (match) {
      debugLog('REDMINE-FIND', 'Found via selector:', selector);
      return match;
    }
  }

  debugLog('REDMINE-FIND', 'No text element found');
  return null;
}

/**
 * Extract text from a Redmine text block element.
 * Clones the element and strips code blocks, images, and embedded objects.
 * @param {HTMLElement} element - Text block element
 * @returns {string}
 */
export function extractRedmineText(element) {
  const clone = element.cloneNode(true);

  // Remove code blocks, images, and embedded objects
  clone.querySelectorAll('pre, code, img, object').forEach(el => el.remove());

  return clone.textContent?.trim() || '';
}

/**
 * Get all visible text blocks on the page matching target selectors.
 * Used for auto-highlighting.
 * @returns {HTMLElement[]}
 */
export function getRedmineTextBlocks() {
  const blocks = [];
  for (const selector of TARGET_SELECTORS) {
    const elements = document.querySelectorAll(selector);
    elements.forEach(el => blocks.push(el));
  }
  return blocks;
}
