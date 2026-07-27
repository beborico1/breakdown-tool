# Japanese in Color

A Chrome extension that colors every Japanese word on the web by the job it does in the sentence,
and tells you how it is read and what it means when you hover it.

Everything runs on your machine: a bundled kuromoji tokenizer, JMdict glosses, KANJIDIC readings,
and Chrome's built-in on-device translator. No account, no API key, no server.

## Features

- **Color on every site** — switch it on once and any page with Japanese on it gets colored by
  part of speech. Pause it per site whenever you want.
- **Hover for meaning** — reading, romaji, and English for any word; hover a clause-ending dot for
  the whole clause.
- **Click words together** — click a colored word, then click the one next to it, and the run joins
  into a band you can hover for the whole phrase. Escape clears it. Where the site owns the click
  (a headline that is also a link) hold <kbd>Alt</kbd> and click instead.
- **Your words** — every word you meet is tracked, searchable, and exportable to Anki via
  AnkiConnect (on your own machine).
- **Google Meet, Chat, Gmail and Redmine** get purpose-built handling: live caption breakdowns,
  transcript copy, and per-message analysis.
- **Speak & check** — say something in Japanese and see it broken down.
- **Insights** — a local dashboard of what you have used, stored only on your machine.

## Development

```bash
npm install
npm run build        # dictionaries + bundles
npm run package      # the Chrome Web Store zip, from a computed file set
```

Load `build/` (not the repo root) via **Load unpacked** to test what users actually install.

### Tests

```bash
npm run test:nlp     # the offline pipeline, in node
npm run test:unit    # word cache, frequency store, jmdict index, clauses, metrics
npm run test:dom     # colorizer DOM behaviour in headless Chromium
npm run test:pages   # every extension page loads clean (needs a display)
npm run test:e2e     # end-to-end analyze through the service worker (needs a display)
```

`test:nlp` and `test:unit` run in CI; the Playwright suites need a real Chromium with the
extension loaded, so they stay local.

## Privacy

Page text is analyzed on your computer and never uploaded. Usage metrics are stored locally and
never transmitted — see [PRIVACY_POLICY.md](PRIVACY_POLICY.md) and
[docs/metrics-remote-sink.md](docs/metrics-remote-sink.md).
