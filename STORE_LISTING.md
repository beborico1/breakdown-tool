# Chrome Web Store Listing — Reference Copy

Paste these into the developer dashboard at https://chrome.google.com/webstore/devconsole/
(signed in as `luiscarlosricoalamda@gmail.com`).

## Name
会議 kaigi meeting

## Short description (≤132 characters)
Japanese learning companion. Word-by-word breakdowns of Google Meet captions, selected text, and live mic transcriptions.

## Detailed description
会議 kaigi meeting is a Japanese-learning companion for Google Meet, Google Chat, and beyond. Click any Japanese caption, highlight text, or speak into your mic to get an instant word-by-word breakdown with readings, romaji, and English meanings, powered by Google's Gemini API using your own API key.

Key features:

• Caption analysis on Google Meet — click any Japanese caption to see a color-coded grammar breakdown.
• Right-click analysis on Google Chat and Gmail — select Japanese text and translate on demand.
• Live Japanese Transcription — a dedicated page that transcribes your microphone in real time and breaks each utterance into words.
• Word Frequency Dashboard — tracks vocabulary you have encountered across sessions and lets you export to CSV/JSON.
• Optional Anki sync — push selected vocabulary to your local Anki install via AnkiConnect (opt-in, localhost only).
• Custom Sites — enable Japanese analysis on your own Redmine or other sites by adding the URL in the popup. Chrome requests permission per site, on demand.

Getting started:

1. Install the extension.
2. Click the toolbar icon, paste your Gemini API key (create one free at aistudio.google.com/apikey), and choose a model.
3. Open Google Meet, Google Chat, or Live Transcription and start analyzing.

Your Gemini API key never leaves your browser except to reach Google's Gemini API. No analytics, no tracking, no third-party servers.

## Category
Productivity

## Languages
English (primary), Japanese

## Privacy policy URL
https://luiscarlosricoalamda.github.io/kaigi-meeting-privacy/
(Create this per the plan's Phase 2.3 before submitting.)

---

## Privacy practices form

### Single purpose
Provide on-the-fly Japanese word breakdowns for Google Meet captions, selected text in Google Chat/Gmail, and live microphone transcriptions, to help users learn Japanese.

### Permission justifications

**clipboardWrite**
Used to copy extracted captions, transcripts, and word breakdowns to the user's clipboard via the popup's copy buttons.

**activeTab**
Used so that the popup's copy and translate actions operate only on the active Google Meet or Google Chat tab the user explicitly interacts with.

**storage**
Stores the user's Gemini API key, model preference, UI settings (font size, chunk size), token usage counter, word-frequency data, Anki sync preferences, and the user-curated list of custom sites — all locally in chrome.storage.

**scripting**
Used to dynamically register content scripts for user-added custom sites (see optional host permission https://*/* below). No Redmine URL is statically matched in the manifest; everything custom is opt-in per site.

**Host permission: https://generativelanguage.googleapis.com/***
The extension sends caption, selected, or mic-transcribed text to Google's Gemini API for Japanese word analysis, using the API key the user provides.

**Optional host permission: http://localhost:8765/***
Used by the optional AnkiConnect integration on the Word Frequency dashboard. The extension requests this permission only when the user clicks "Sync to Anki" or "Test Connection". Data is sent only to the user's own local Anki install — never offsite.

**Optional host permission: https://\*/\***
Used by the "Custom Sites" feature: the user enters a URL (e.g. their own Redmine instance) in the popup, Chrome prompts for permission to that specific origin, and only then does the extension register a content script on that site. The extension never requests access to all sites up front — permission is scoped per user-added URL.

### Data usage disclosures
- **User activity (selected text, captions, mic audio)**: sent to Google's Gemini API with the user's own API key, for the core translation/analysis functionality. Not collected, stored, or transmitted elsewhere.
- **Authentication information (Gemini API key)**: stored locally in chrome.storage.sync; sent only to Google's Gemini API.
- **Personal communications**: *not* collected. Caption and chat text are processed on-demand per user action; nothing is stored remotely.
- **Web history, location, health, financial, personally identifiable info**: *not* collected.

### Data handling certifications
- I do not sell or transfer user data to third parties outside the approved use cases (sending to Google Gemini with the user's key).
- I do not use or transfer user data for purposes unrelated to the item's core functionality.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## Distribution
- Visibility: Public
- Regions: All
- Pricing: Free

---

## Post-submission review notes

If the reviewer questions the broad `https://*/*` optional host permission:

> The extension never requests https://\*/\* as a single blanket grant. It is declared only so that `chrome.permissions.request({ origins: ["https://<user-entered-url>/*"] })` can be called with a specific URL when the user opts into enabling analysis on their own site (e.g. their company Redmine). Chrome prompts the user for each URL individually. If the user declines, no permission is granted. If the user later wants to remove a site, the popup also calls `chrome.permissions.remove` to revoke it. There is no up-front blanket permission prompt.
