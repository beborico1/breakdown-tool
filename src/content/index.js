/**
 * Kaigi Meeting - Google Meet Caption Translator & Google Chat Word Breakdown
 *
 * Entry point for the content script that provides:
 * - Japanese word breakdown with color-coded grammar types
 * - Minimalistic mode with inline colored text
 * - Google Chat context menu for Japanese analysis
 * - Clipboard operations for caption copying
 */

import { initializeGoogleMeet } from './meet/index.js';
import { initializeGoogleChat } from './chat/index.js';
import { initializeGmail } from './gmail/index.js';
import { initializeRedmine } from './redmine/index.js';

// Initialize features based on current page
initializeGoogleMeet();
initializeGoogleChat();
initializeGmail();
initializeRedmine();
