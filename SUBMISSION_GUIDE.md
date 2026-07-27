# Chrome Web Store Submission Guide — Japanese in Color v2.0.0

Work top to bottom. Everything that can be automated is; what remains is the parts that need a
human in front of a browser.

Files this guide relies on:

- `japanese-in-color-v2.0.0.zip` — the upload package, produced by `npm run package`
- `assets/store-screenshots/` — five 1280×800 screenshots plus the 440×280 promo tile,
  produced by `npm run screenshots`
- `STORE_LISTING.md` — paste-ready copy for every form field
- `PRIVACY_POLICY.md` — the policy text; published to GitHub Pages by `npm run site`

---

## Step 0 — Close the data exposure first

**This blocks everything else.** The repository is public and, until the purge is pushed, four
files are readable by anyone: a real meeting transcript, a captured Gmail page containing eight
third-party email addresses, a colleague's chat messages, and a stale build zip.

```bash
bash scripts/purge-history.sh     # rewrites a local mirror; pushes nothing
```

Review the mirror it prints, then force-push it. Afterwards:

```bash
bash scripts/verify-purge.sh japanese-in-color    # every line must read 404
```

Two things the rewrite cannot do, and which are part of finishing the job:

- **Ask GitHub Support to garbage-collect the repository.** Until they do, the files are still
  retrievable by anyone holding an old commit SHA.
- **Tell the colleague** whose messages were in `sample.html`, and decide whether the third-party
  addresses need disclosing.

---

## Step 1 — Build and smoke-test what will actually ship

```bash
npm ci
npm run icons          # only if the icon master changed
npm run screenshots    # only if the UI changed
npm run package
```

`npm run package` refuses to run if `manifest.json` and `package.json` disagree on the version, if
any dictionary directory is empty, or if a denylisted file reached the tree. It leaves the exact
staged contents at `build/`.

Then load **`build/`**, not the repo root, so you are testing the artifact rather than the working
copy:

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → select `build/`.
2. Confirm the card reads **Japanese in Color 2.0.0** with no **Errors** badge.
3. Pin it: puzzle-piece icon → pin **Japanese in Color**.

### Smoke test

Zero red console errors at every step (right-click the toolbar icon → **Inspect popup**; and
DevTools on the page for content-script errors).

- [ ] The welcome page opened by itself on install, its sample sentence is coloured, and hovering a
      word shows a reading and a meaning.
- [ ] The colour legend on the welcome page matches the colours in the sample.
- [ ] Popup: heading reads **Japanese in Color**, the all-sites switch is **off**, and the
      permission explanation is visible above it.
- [ ] Turn the switch on: exactly one Chrome prompt, then the page you are on gets coloured
      **without a reload**.
- [ ] Open a Japanese page in a new tab — it colours automatically.
- [ ] Hover a word: reading, romaji, meaning. Hover a sentence-ending dot: the clause in English
      (needs Chrome 138+ for the on-device translator; if absent, word hover must still work).
- [ ] Ctrl+F for a phrase spanning two coloured words — it must match. Copy a coloured sentence
      and paste it: no extra spaces.
- [ ] **Pause on this site** removes the colour with no reload; the page text is unchanged;
      **Resume** brings it back.
- [ ] Turn the switch off: `chrome://extensions` → Details → Site access shows `https://*/*` gone.
- [ ] On Google Meet / Chat / Gmail the popup says "Coloring …", **not** "this tab was open
      before you turned it on".
- [ ] **Your words** lists what you hovered; **Export CSV** downloads.
- [ ] **Insights** shows non-zero numbers, and **Delete all** empties it.
- [ ] Toolbar icon is legible at 100% zoom on both a light and a dark toolbar.
- [ ] Visit five ordinary non-Japanese sites: the page console stays silent.

Automated suites, for what they cover:

```bash
npm run test:nlp && npm run test:unit     # also run in CI
npm run test:dom && npm run test:pages    # need a display
npm run test:universal && npm run test:e2e
```

---

## Step 2 — Publish the privacy policy

The store requires a live URL. It is generated from `PRIVACY_POLICY.md` so the hosted copy cannot
drift from the one in the repo.

1. Rename the repository to **japanese-in-color** (Settings → General → Repository name), then
   `git remote set-url origin https://github.com/beborico1/japanese-in-color.git`.
   Do this **before** filing the URL: GitHub redirects a renamed repo's web and git traffic, but
   old `*.github.io` project paths are **not** redirected.
2. Settings → **Pages** → Source: **GitHub Actions**. The `Pages` workflow publishes only `site/`.
3. Push to `main`. The workflow builds and deploys.
4. Verify in an incognito window:
   - `https://beborico1.github.io/japanese-in-color/privacy` renders, permission table included.
   - `https://beborico1.github.io/japanese-in-color/SUBMISSION_GUIDE.md` returns **404** — only
     `site/` is published, and this guide is not in it.

Paste `https://beborico1.github.io/japanese-in-color/privacy` into the listing's privacy field.

---

## Step 3 — Screenshots

Already generated into `assets/store-screenshots/`:

| File | Shows |
|---|---|
| `1-article-word-tooltip.png` | A Japanese article coloured, with a word tooltip open |
| `2-article-colorized.png` | Several paragraphs of colour — the density shot |
| `3-your-words.png` | The vocabulary dashboard, populated |
| `4-welcome.png` | The live sample and the colour legend |
| `5-popup.png` | The popup switched on, over a coloured page |
| `promo-tile-440x280.png` | Small promo tile |

All content is original — no third-party page appears in any of them. Re-run `npm run screenshots`
after any UI change; it fails rather than producing a frame with the tooltip missing.

---

## Step 4 — Fill in the listing

Everything is paste-ready in `STORE_LISTING.md`: name, short and detailed description, category
(**Education**), single purpose, a justification for every permission, the data-usage disclosures,
and a pre-written note for the reviewer about the optional all-hosts permission.

- [ ] Upload `japanese-in-color-v2.0.0.zip` under **Package**.
- [ ] Upload the five screenshots and the promo tile.
- [ ] Paste the privacy policy URL from Step 2.
- [ ] Complete the privacy practices form from `STORE_LISTING.md`.
- [ ] Distribution: Public, all regions, free.

---

## Step 5 — After submitting

Reviews typically take a few days and can take longer for an extension that requests broad host
access. If the reviewer questions `https://*/*`, the answer is already written at the end of
`STORE_LISTING.md`: it is optional, ships off, is requested from a user gesture, and is revoked
when the feature is switched off.

### Future updates

1. Bump the version in **both** `manifest.json` and `package.json` — `npm run package` refuses if
   they disagree.
2. `npm run package`
3. Dashboard → existing item → **Package** → **Upload new package** → submit.

---

## Known issues at submission

`docs/known-issues.md` records two open defects (a Meet caption repaint and a Gmail
back-to-original edge case). Neither affects the all-sites flow a reviewer will exercise.
