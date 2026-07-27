# Chrome Web Store Listing — Japanese in Color

Paste these into the developer dashboard at https://chrome.google.com/webstore/devconsole/
(signed in as `luiscarlosricoalmada@gmail.com`).

## Name

Japanese in Color

## Short description (≤132 characters)

Color every Japanese word by its part of speech, with readings and meanings. Free, private, runs on your computer.

## Detailed description

Japanese in Color makes Japanese text readable at a glance. Turn it on and every Japanese word on
any page gets a color for the job it does in the sentence — nouns, verbs, particles, adjectives —
so the shape of a sentence is visible before you have parsed a single word. Hover any word to see
how it is read, its romaji, and what it means.

Everything runs on your own computer. The extension ships with a Japanese tokenizer, JMdict
English glosses, and KANJIDIC kanji readings built in. There is no account, no sign-in, and no API
key to configure — install it, switch it on, and read.

Key features:

• Color on every website — one switch turns on coloring everywhere. Pause it on individual sites,
  or switch it off entirely, whenever you want.
• Hover for meaning — reading, romaji, and English for any word. Hover a sentence-ending dot for
  the whole clause in English.
• Click words together — click a colored word, then the one beside it, and the run joins into a
  band. Hover the band for the whole phrase in English. Alt+click where the page owns the click.
• Your words — every word you meet is collected into a searchable dashboard, with how often you
  have seen it, so you can watch your own vocabulary grow.
• Send to Anki — push a selection of your vocabulary into Anki through the AnkiConnect add-on
  running on your own machine, with a purpose-built card layout.
• Google Meet, Chat and Gmail — live caption breakdowns during a call, transcript copying, and
  per-message analysis.
• Speak & check — say something in Japanese and see it broken down word by word.
• Insights — a local dashboard showing exactly what the extension has recorded about your usage,
  with an export and a delete-everything button.

Your privacy:

The text on the pages you read is analyzed on your computer and is never uploaded. Usage
statistics are stored locally so you can look at them, and are never transmitted. Two features do
reach other services, and both say so plainly in the product: Speak & check uses Chrome's speech
recognition, which sends your microphone audio to Google, and Chrome may download an on-device
translation model the first time you hover a sentence.

Getting started:

1. Install the extension. A welcome page opens with a live sample you can hover.
2. Click "Turn on coloring" and accept Chrome's permission prompt.
3. Open any Japanese page.

## Category

Education

## Language

English (primary), Japanese

## Privacy policy URL

https://beborico1.github.io/japanese-in-color/privacy

Generated from `PRIVACY_POLICY.md` by `npm run site` and published by the `Pages` workflow, so the
hosted copy cannot drift from the one in the repo. Requires the repository to be renamed to
`japanese-in-color` and Pages set to the **GitHub Actions** source — see `SUBMISSION_GUIDE.md`
Step 2. Confirm it returns 200 before filing.

---

## Privacy practices form

### Single purpose

Help people read Japanese by coloring each word on a page according to its part of speech and
showing its reading and meaning, using dictionaries bundled with the extension and processed
entirely on the user's device.

### Permission justifications

**activeTab**
The toolbar popup reads the active tab's URL to decide what to show (whether the page is a Google
Meet call, whether coloring is running on it) and sends it messages for the copy-transcript
actions. Only the tab the user has explicitly opened the popup on is involved.

**storage**
Stores the user's vocabulary list, their settings (coloring on/off, per-site pauses, display
preferences), Anki preferences, and local usage statistics. All of it stays in chrome.storage on
the user's machine.

**scripting**
Registers and unregisters the coloring content script when the user turns all-sites coloring on or
off, and injects it into the current tab when they turn it on, so the page they are already
looking at gets colored without a reload.

**offscreen**
Runs the Japanese tokenizer and the bundled dictionaries in an offscreen document, so a large
dictionary load happens off the page's main thread and can be released when idle.

**alarms**
Two housekeeping timers: closing the offscreen document after a period with no analysis to free
dictionary memory, and pruning locally stored usage statistics older than 90 days. Both outlive
the MV3 service worker's ~30 second idle lifetime, so neither can be a setTimeout.

**unlimitedStorage**
The bundled dictionaries and the user's accumulated vocabulary exceed Chrome's default 10 MB
extension storage quota.

**Optional host permission: https://\*/\* and http://\*/\***
This is the "Color Japanese on every website" feature. The extension **ships with it switched
off** and does not request it at install time. It is requested only from a user gesture — the
toggle in the popup, or the button on the welcome page — and the popup explains, before the user
touches the switch, that Chrome will ask to let the extension read data on all sites, and why.
Turning the switch off **revokes** the permission again. There is also a per-site pause. Nothing
read from those pages is transmitted: the analysis happens on the device.

**Optional host permission: http://localhost:8765/\***
The optional AnkiConnect integration on the "Your words" page. Requested only when the user
actually uses the Anki export. Data goes only to the Anki instance running on the user's own
computer.

### Data usage disclosures

- **Website content**: the extension reads text from the pages the user visits in order to find
  and color Japanese words. It is processed on the user's device and is **not** collected,
  transmitted, or stored remotely. The user's own vocabulary list is saved locally on their
  machine so they can review it.
- **User activity**: local usage counters (words colored, tooltips opened, failures) are stored on
  the device and shown to the user on the Insights page. Not transmitted.
- **Personal communications**: the extension has static content scripts on Google Meet, Google
  Chat, and Gmail, so it does process caption and message text on those surfaces in order to color
  it. That processing is entirely local, and nothing is transmitted or retained beyond the user's
  own vocabulary list. Declared for transparency rather than because anything leaves the device.
- **Authentication information, financial information, health information, location, web history,
  personally identifiable information**: not collected.

### Data handling certifications

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to the item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## Distribution

- Visibility: Public
- Regions: All
- Pricing: Free

---

## Note for the reviewer

The broad optional host permission is the extension's main feature, and it is opt-in rather than
assumed:

> `https://*/*` and `http://*/*` are declared as **optional** host permissions and are not
> requested at install time. The extension ships with all-sites coloring switched off. The
> permission is requested only from an explicit user gesture, and the UI explains what Chrome is
> about to ask for, and why, before the user acts. Switching the feature off calls
> `chrome.permissions.remove()` for both origins, so the grant does not outlive the feature, and
> users can pause individual sites without giving anything up. Page text read under this
> permission is analyzed on-device by bundled dictionaries and is never transmitted — the
> extension declares no required host permissions at all, and its only network-capable code path
> is a proxy hard-restricted to `http://localhost:8765` for the optional Anki integration.
