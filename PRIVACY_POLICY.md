# Privacy Policy for Japanese in Color

**Last updated**: July 27, 2026

Japanese in Color colors Japanese words on the pages you read and tells you how they are read
and what they mean. This policy describes what the extension does with data, and what leaves
your computer.

## Summary

- **The text on the pages you visit is analyzed on your computer and is never uploaded.**
- There is no account, no sign-in, and no API key.
- Usage statistics are stored locally so you can see them; they are not transmitted anywhere.
- Two features do involve other services, and both are described below: the **Speak & check**
  page uses Chrome's speech recognition (which sends microphone audio to Google), and Chrome
  may download an on-device translation model from Google the first time you hover a sentence.
- Nothing is sold, shared, or used for advertising.

## How the analysis works

The word analysis runs entirely inside the extension, using dictionaries bundled in the
download: a kuromoji tokenizer, JMdict English glosses, and KANJIDIC kanji readings. Page text is
read into the extension's own hidden document, analyzed there, and the colors and tooltips are
drawn back onto the page. No page text is sent over the network at any point.

## What the extension reads

### Pages you visit

When you turn on "Color Japanese on every website", Chrome asks for permission to read data on
all sites, and the extension looks for Japanese text on the pages you open. This is what the
feature does — it cannot find Japanese on a page it cannot read.

The extension ships with this switched **off**. You can turn it off again at any time, which also
releases the permission, and you can pause it on individual sites.

Without that permission, the extension reads only Google Meet, Google Chat, and Gmail, which are
listed in its manifest.

### What is stored on your computer

All of this lives in Chrome's extension storage on your machine, and none of it is sent to us or
to anyone else:

- The words you have encountered, with readings, meanings, and how often you have seen them.
- A cache of recently analyzed words, to avoid re-analyzing the same text.
- Your settings: whether coloring is on, which sites you have paused, and display preferences.
- Anki settings, if you use the Anki export.
- Usage statistics (see below).

## Usage statistics

The extension counts how it is used — things like how many words were colored, how often tooltips
were opened, how long analysis took, and how often it failed. This exists so the extension can be
improved.

**These statistics never leave your computer.** There is no analytics service, no endpoint, and no
code in the extension that can transmit them. You can see everything that is recorded on the
**Insights** page (toolbar icon → Insights), export it, and delete all of it with one button.

By design, the statistics cannot contain any page content: the internal interface that records
them accepts only a fixed list of predefined event names, so a web address, a site name, a page
title, or analyzed text cannot become a statistic even by mistake.

If this ever changes it will require a new permission that Chrome will show you, an updated
version of this policy, and your explicit consent first.

## Features that use other services

### Speak & check (microphone transcription)

The Speak & check page uses **Chrome's built-in speech recognition** to turn what you say into
text. On desktop Chrome this sends your microphone audio to Google's speech service. That is
Chrome's behavior rather than something the extension controls, and it happens only while you are
actively listening on that page. It is stated on the page itself.

Once the text comes back, the word breakdown runs on your computer like everywhere else. The
transcript is not stored anywhere except in that page, until you close it.

Google's handling of speech data is governed by Google's own privacy policy.

### On-device translation

Hovering a sentence-ending dot shows an English translation produced by Chrome's built-in
translator, which runs on your device. The first time it is used, Chrome may download a
translation model from Google. The text being translated is not uploaded — the model comes to
your machine, not the other way around.

If the translator is unavailable, word colors and meanings still work; only sentence translation
is missing.

### Anki (optional, on your own machine)

If you use the Anki export on the **Your words** page, the extension asks for permission to reach
`http://localhost:8765` and sends the vocabulary you selected to the AnkiConnect add-on running on
your own computer. This data never leaves your device. You can revoke the permission at any time
from Chrome's extension settings.

## What is never collected

- No personal identifiers (name, email, address).
- No browsing history, and no record of which sites you visited.
- No page content, page titles, or web addresses — not remotely, and not in the local statistics.
- No advertising identifiers.
- Nothing is transmitted to the developer.

## Permissions and why they exist

| Permission | Why |
|---|---|
| `activeTab` | Lets the toolbar popup act on the tab you are looking at, only when you open it. |
| `storage` | Stores your words, settings, and local statistics. |
| `scripting` | Registers the coloring script when you turn all-sites coloring on, and removes it when you turn it off. |
| `offscreen` | Runs the dictionaries and the tokenizer in a hidden document, off the page's thread. |
| `alarms` | Frees dictionary memory after a period of inactivity, and prunes old local statistics. |
| `unlimitedStorage` | The bundled dictionaries and your saved vocabulary can exceed Chrome's default 10 MB. |
| `https://*/*`, `http://*/*` (optional) | All-sites coloring. Requested only when you switch it on, released when you switch it off. |
| `http://localhost:8765/*` (optional) | Anki export. Requested only when you use it. |

## Changes to this policy

If this policy changes, the updated version will be posted at the URL this policy is hosted at,
and the "Last updated" date will change.

## Contact

For privacy questions, contact: luiscarlosricoalmada@gmail.com
