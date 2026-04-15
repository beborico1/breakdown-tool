# Privacy Policy for 会議 kaigi meeting

**Last updated**: April 15, 2026

This Chrome extension ("kaigi meeting") is a Japanese-learning companion that
breaks down captions, selected text, and microphone transcriptions into words
with readings, grammar, and meanings. This policy describes what data the
extension handles and where it goes.

## Summary

- The extension sends text you trigger analysis on (captions, selected text,
  microphone transcriptions) to Google's Gemini API, using an API key **you
  supply**.
- No other data leaves your device.
- No analytics, no tracking, no third-party servers besides the Gemini API.
- No data is sold, shared, or used for advertising.

## Data handled

### What is sent to Google's Gemini API

When you trigger analysis (by clicking a caption, right-clicking selected
text, or using Live Japanese Transcription), the extension sends the following
to `https://generativelanguage.googleapis.com/`:

- The text being analyzed (caption, selection, or mic-transcribed audio).
- Your Gemini API key, which **you** provide in the extension's popup.

Google's handling of this data is governed by Google's own terms. See
<https://ai.google.dev/gemini-api/terms>.

### What is stored locally

The extension stores the following in Chrome's extension storage (`chrome.storage`),
never on any remote server we control:

- Your Gemini API key and model preference (`chrome.storage.sync`).
- UI preferences (font size, chunk size, custom site list)
  (`chrome.storage.sync`).
- Token usage counter and word-frequency data (`chrome.storage.local`).
- Anki sync preferences (`chrome.storage.local`).

Data saved to `chrome.storage.sync` is synchronized across your Chrome
profiles by Google's own sync infrastructure.

### Optional: AnkiConnect (local, opt-in)

If you choose to use the Anki sync feature on the word frequency page, the
extension will ask for permission to access `http://localhost:8765` and send
vocabulary data to the AnkiConnect add-on running on your own computer. This
data **never leaves your device**. You can revoke this permission at any time
from Chrome's extension settings.

### Optional: Custom sites (user-added)

The extension lets you enable Japanese analysis on additional sites (such as
your own Redmine instance) via the "Custom Sites" section of the popup. When
you add a site, Chrome will ask for permission to run the extension on that
site. No data is sent anywhere new — analysis still only uses Gemini, the same
as on Google Meet.

## What we do not collect

- No personal identifiers (name, email, address).
- No browsing history.
- No analytics, telemetry, or crash reports.
- No advertising identifiers.

## Changes to this policy

If this policy changes, the updated version will be posted at the same URL
this policy is hosted at. The "Last updated" date at the top will reflect
the change.

## Contact

For privacy questions, contact: a01252831@tec.mx
