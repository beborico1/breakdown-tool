/**
 * Japanese in Color - content-script entry point
 *
 * Entry point for the content script that provides:
 * - Japanese word breakdown with color-coded grammar types
 * - Minimalistic mode with inline colored text
 * - Google Chat context menu for Japanese analysis
 * - Clipboard operations for caption copying
 * - Universal (all-sites) Japanese colorizing on opt-in
 */

import { initializeGoogleMeet } from './meet/index.js';
import { initializeGoogleChat } from './chat/index.js';
import { initializeGmail } from './gmail/index.js';
import { initializeRedmine } from './redmine/index.js';
import { initializeUniversal } from './universal/index.js';
import { initDisplayPreferences } from './core/display-preferences.js';

// Single-execution guard: the same frame can match both the static manifest
// registration and a dynamic registration (universal mode, or a user custom
// site), which would inject this bundle twice and double-bind every observer.
if (window.__kaigiLoaded) {
  // Already initialized in this frame.
} else {
  window.__kaigiLoaded = true;

  // Apply display-preference classes to <html> before any surface renders.
  initDisplayPreferences();

  // Initialize features based on current page.
  initializeGoogleMeet();
  initializeGoogleChat();
  initializeGmail();
  initializeRedmine();
  initializeUniversal();
}
