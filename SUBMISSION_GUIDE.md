# Chrome Web Store Submission Guide — 会議 kaigi meeting v1.2.0

Follow this guide top to bottom. Each step has a checklist. Do not skip the smoke test — a rejected review costs days; a 15-minute local test catches most issues.

**Files already prepared** (at repo root):
- `kaigi-meeting-v1.2.0.zip` — the upload package (160 KB)
- `PRIVACY_POLICY.md` — the privacy policy (goes to GitHub Pages)
- `STORE_LISTING.md` — paste-ready copy for every form field
- `LICENSE` — MIT, shipped inside the ZIP

---

## Step 1 — Smoke test locally (20 minutes)

**Goal**: Prove the extension works in a clean Chrome profile before submitting. If anything fails here, it will fail review.

### 1.1 Open the extensions page
1. Open Chrome.
2. In the address bar, type: `chrome://extensions` and press Enter.
3. Top-right of the page, toggle **Developer mode** ON.

### 1.2 Load the extension
1. Click **Load unpacked** (top-left).
2. In the file picker, navigate to `/Users/luisrico/dev/google-meet-caption-copier/` and click **Select**.
3. You should see a card appear for "会議 kaigi meeting" with version 1.2.0.
4. If there are errors, click **Errors** on the card — they must all be fixed before submitting.

### 1.3 Pin the extension (so you can click it easily)
1. Click the puzzle-piece icon in the Chrome toolbar.
2. Click the pin icon next to "会議 kaigi meeting".

### 1.4 Set up the Gemini API key
1. Click the extension's toolbar icon — popup opens.
2. Click **Gemini API Key** to expand.
3. If you don't have a key yet, click **How to get a key?** and follow the steps at https://aistudio.google.com/apikey.
4. Paste your key and click **Save**. Confirm "API key saved" appears.

### 1.5 Smoke test checklist

Tick each item as you verify it. Open DevTools (Right-click → **Inspect** → **Console** tab) in the relevant tab and confirm **zero red errors** at every step.

- [ ] **Popup opens** without console errors (right-click the extension icon → **Inspect popup** → Console).
- [ ] **Google Meet captions**: join or start a Google Meet with captions enabled, click a Japanese caption. A word-breakdown panel appears.
- [ ] **Copy All Captions** button in popup works on a Meet tab. Paste into a text editor to confirm.
- [ ] **Live Japanese Transcription**: click the button in the popup → a new tab opens → click **Start Listening** → grant mic permission → speak Japanese → breakdowns appear under "Breakdown History".
- [ ] **Copy JP / Copy EN / Download TXT** on the transcribe page all work.
- [ ] **Google Chat right-click**: open `https://chat.google.com`, select Japanese text in a message, press **Alt+J** (or click **Translate Selection to Japanese** in popup). Translation appears.
- [ ] **Custom Sites — add**: open popup → expand **Custom Sites** → paste a URL (e.g. `https://www.redmine.org/`) → click **Add**. Chrome prompts for permission. Click **Allow**. A green "Site added" message appears and the URL shows in the list below.
- [ ] **Custom Sites — verify script runs**: open the URL you just added in a new tab and confirm the extension's analysis works (e.g. hover/click Japanese text).
- [ ] **Custom Sites — remove**: back in the popup, click the **×** next to the URL. List empties. Reload the site: extension no longer injects.
- [ ] **Custom Sites — persistence**: fully quit Chrome (Cmd+Q), reopen, confirm the URL re-registers (add one again, quit, reopen, visit the site — still works).
- [ ] **Anki permission prompt (optional)**: open popup → click **View Word Frequency Dashboard** → click **Sync to Anki**. Chrome prompts for access to `http://localhost:8765`. (If you click Deny, the button should prompt again next time — verify.)
- [ ] **Zero console errors** across all flows above.

### 1.6 If anything fails
- Check the `chrome://extensions` page for a red **Errors** badge on the extension card.
- Check the service worker: click **service worker** (inspect) on the extension card → Console.
- Check the popup: right-click the toolbar icon → **Inspect popup**.
- Fix the issue, click the refresh-circle icon on the extension card to reload, re-run the failing step.
- If the fix requires a rebuild: `cd /Users/luisrico/dev/google-meet-caption-copier && npm run build`, then click the refresh-circle on the extension card.

---

## Step 2 — Host the privacy policy on GitHub Pages (15 minutes)

**Goal**: The Chrome Web Store requires a public URL to your privacy policy. We'll host it on GitHub Pages for free.

### 2.1 Sign into GitHub
1. Go to https://github.com
2. Sign in as `luiscarlosricoalamda` (or whatever account you want to host the policy on — make sure it's one you'll keep long-term).

### 2.2 Create the public repo
1. Top-right, click the **+** icon → **New repository**.
2. **Repository name**: `kaigi-meeting-privacy`
3. **Description** (optional): `Privacy policy for the kaigi meeting Chrome extension`
4. Visibility: **Public** ← must be public for GitHub Pages to work on free accounts
5. Tick **Add a README file** (we'll replace its contents in the next step).
6. Click **Create repository**.

### 2.3 Upload the privacy policy as README
1. In your new repo, click the pencil ✏️ icon next to `README.md`.
2. Delete all the placeholder content.
3. Open `/Users/luisrico/dev/google-meet-caption-copier/PRIVACY_POLICY.md` in a text editor, copy its entire contents, and paste into the GitHub editor.
4. Scroll down, click **Commit changes…**, then **Commit changes** in the dialog.

### 2.4 Enable GitHub Pages
1. In the repo, click **Settings** (top menu).
2. Left sidebar, click **Pages**.
3. Under **Source**, choose **Deploy from a branch**.
4. Under **Branch**, choose `main` and folder `/ (root)`. Click **Save**.
5. Wait ~1 minute. Refresh the page. A green banner appears: **"Your site is live at https://luiscarlosricoalamda.github.io/kaigi-meeting-privacy/"**.

### 2.5 Verify it's publicly accessible
1. Open a **new incognito window** (Cmd+Shift+N).
2. Paste the URL from step 2.4 and press Enter.
3. The privacy policy should render. If it shows a 404, wait another minute and retry — deployment is sometimes slow on the first go.

**Save this URL — you'll paste it into the Chrome Web Store form in Step 4.**

---

## Step 3 — Capture screenshots (30 minutes)

**Goal**: Five screenshots at exactly **1280 × 800 pixels** showing the extension in action.

### 3.1 Prepare a clean capture window

Option A (simplest) — use the built-in Chrome window and crop:
1. Resize your Chrome window to roughly 1280×800. (Use **Rectangle** / **Spectacle** / **Magnet** window managers to snap, or just drag manually.)
2. For each screenshot below, press **Cmd+Shift+4**, then press **Space**, then click the browser window. Saves to Desktop.
3. Crop/resize to exactly 1280×800 using Preview.app (**Tools → Adjust Size…**).

Option B (cleaner) — use the developer tools device toolbar:
1. Open DevTools (**Cmd+Option+I**).
2. Click the device-toolbar icon (phone/tablet silhouette, top-left of DevTools).
3. At the top, set the dropdown to **Responsive**, set width **1280** and height **800**.
4. Press **Cmd+Shift+P** in DevTools, type `screenshot`, choose **Capture full size screenshot** or **Capture screenshot**.

### 3.2 The five screenshots to capture

Name them `01-meet-breakdown.png`, `02-live-transcription.png`, etc. Save to `/Users/luisrico/dev/google-meet-caption-copier/assets/store-screenshots/` (create the folder if needed).

- [ ] **01 — Meet caption breakdown**: open a Google Meet with Japanese captions, click a caption, capture with the breakdown panel visible.
- [ ] **02 — Live Japanese Transcription**: open the Live Transcription page mid-session with several "Breakdown History" entries visible.
- [ ] **03 — Google Chat right-click / Alt+J**: a Google Chat message with a Japanese translation inserted / shown.
- [ ] **04 — Popup with Custom Sites**: open the popup, expand **Gemini API Key** and **Custom Sites** sections so both are visible, with at least one site in the list.
- [ ] **05 — Frequency Dashboard**: the Word Frequency Dashboard page with some vocabulary loaded and a few words checked.

### 3.3 Quality check each screenshot

- [ ] Exactly 1280×800 pixels (verify in Preview → **Tools → Show Inspector**).
- [ ] No personal info visible (real names from Meet calls, your real API key, private chat content). Either anonymize or use test accounts.
- [ ] No other browser tabs/windows bleeding in.
- [ ] Japanese text and UI elements are crisp, not blurry.

### 3.4 Optional: promo tiles
If you want to polish the listing further:
- **Small promo tile**: 440 × 280 px
- **Marquee promo tile**: 1400 × 560 px

These are not required but make the listing stand out. Skip for v1.2.0 if short on time — you can add them in a later listing update.

---

## Step 4 — Upload to the Chrome Web Store (20 minutes)

### 4.1 Sign in with the right account
1. Open a **new incognito window** (Cmd+Shift+N). This avoids the "wrong Google account" trap.
2. Go to https://chrome.google.com/webstore/devconsole/
3. Sign in with **`luiscarlosricoalamda@gmail.com`** (this is the account with your existing developer registration; no $5 fee should appear).
4. You should see your dashboard with "Wikipedia Donation Banner Remover" listed. If Google prompts for the $5 fee, you signed in with the wrong account — sign out and retry.

### 4.2 Create the new item
1. Click **+ New item** (top right).
2. Drag-and-drop `kaigi-meeting-v1.2.0.zip` or click and select the file.
3. Wait for the upload to finish (~10 seconds).

### 4.3 Fill the Store listing tab

Open `STORE_LISTING.md` in one window, the dashboard in another, and paste each field.

- [ ] **Product name**: `会議 kaigi meeting`
- [ ] **Summary** (short description, 132 chars): from STORE_LISTING.md "Short description"
- [ ] **Description**: from STORE_LISTING.md "Detailed description"
- [ ] **Category**: **Productivity**
- [ ] **Language**: English (primary). Add Japanese as a secondary language if offered.
- [ ] **Icon**: auto-populated from the manifest (128×128). Verify the purple 会議 icon shows.
- [ ] **Screenshots**: upload the 5 PNGs from Step 3. Drag to reorder — put **01-meet-breakdown** first.
- [ ] **Promo tiles**: skip unless you made them.

### 4.4 Fill the Privacy tab

- [ ] **Single purpose**: from STORE_LISTING.md "Single purpose"
- [ ] **Permission justifications** — one box per permission. Paste each from STORE_LISTING.md "Permission justifications":
  - [ ] `clipboardWrite`
  - [ ] `activeTab`
  - [ ] `storage`
  - [ ] `scripting`
  - [ ] Host permission: `https://generativelanguage.googleapis.com/*`
  - [ ] Remote code use: **No** (your extension bundles all its JS)
- [ ] **Data usage**:
  - Tick: **User activity** (captions, selections, mic audio sent to Gemini)
  - Tick: **Authentication information** (Gemini API key stored locally)
  - Do **NOT** tick: Personal communications, Web history, Location, Health, Financial, PII
- [ ] **Data handling certifications** — tick all three:
  - [ ] "I do not sell or transfer user data to third parties outside the approved use cases"
  - [ ] "I do not use or transfer user data for purposes unrelated to the item's core functionality"
  - [ ] "I do not use or transfer user data to determine creditworthiness or for lending purposes"
- [ ] **Privacy policy URL**: paste the GitHub Pages URL from Step 2.5 (e.g. `https://luiscarlosricoalamda.github.io/kaigi-meeting-privacy/`).

### 4.5 Fill the Distribution tab

- [ ] **Visibility**: **Public**
- [ ] **Distribution regions**: **All regions** (or restrict if you prefer)
- [ ] **Pricing**: **Free**

### 4.6 Final review
1. Click **Save draft** at the top.
2. Scroll back through every tab — any red error banner must be resolved.
3. When every section shows a green check, click **Submit for review** (top right).
4. Confirm in the dialog.

**Expected review time:**
- Typical: 1–3 business days
- Sensitive permissions (the `scripting` + `https://*/*` optional host combo) may extend to 1–2 weeks

---

## Step 5 — After submission

### 5.1 Watch your inbox
Google will email `luiscarlosricoalamda@gmail.com` with approval or rejection. Rejection emails explain exactly what to fix.

### 5.2 Common rejection reasons and how to respond

| Rejection reason | Response |
|---|---|
| "Broad host permissions" about `https://*/*` | Paste the rebuttal from STORE_LISTING.md "Post-submission review notes" — explain this is only for user-opted-in custom sites, one URL at a time, never up-front. |
| "Privacy policy missing/unclear" | Double-check the URL loads publicly, and that it mentions Gemini + API key + no third parties. |
| "Unused permissions" | Should not happen — we already removed `tabCapture` and `offscreen`. If flagged, check `manifest.json` didn't regrow. |
| "Screenshots don't match product" | Re-capture showing the actual UI; avoid mockups. |

### 5.3 If approved
1. Your extension goes live at `https://chromewebstore.google.com/detail/<extension-id>/<slug>`.
2. Share the link.
3. Consider adding a "Install from Chrome Web Store" badge to your `README.md`.

### 5.4 Future updates
1. Bump the version in **both** `manifest.json` and `package.json` (`npm run package` refuses to
   run if they disagree).
2. `npm run package`
3. In the dashboard, click the existing item → **Package** → **Upload new package** → submit for
   re-review.

---

## Quick reference — commands

```bash
# Rebuild after any code change
cd /Users/luisrico/dev/google-meet-caption-copier
npm run build

# Build the submission package (this is the only supported way to produce a zip)
npm run package
```

`npm run package` builds, then assembles the zip from a *computed* file set: it starts at the
manifest and the extension pages and follows every ES import and stylesheet reference, so a module
nothing reaches cannot ship and a module something reaches cannot be forgotten. It refuses to
produce a package if the two version numbers disagree, if any dictionary directory is empty, or if
anything on the denylist (`.md`, `.txt`, `.zip`, `.DS_Store`, `sample.html`, tests, source maps)
made it into the tree.

Do **not** hand-roll a `zip -r ... src/` command. The previous one globbed all of `src/`, which
shipped a captured chat fixture containing a colleague's email address, while passing only
`assets/icons/` — so the 24 MB of dictionaries the on-device pipeline needs were missing and every
install failed on its first analysis.

Smoke-test the real artifact before uploading: `npm run package` leaves the exact staged tree at
`build/`, so load **that** directory via **Load unpacked** rather than the repo root.

---

## Key URLs

| Purpose | URL |
|---|---|
| Chrome Web Store Developer Dashboard | https://chrome.google.com/webstore/devconsole/ |
| Your existing dev account email | `luiscarlosricoalamda@gmail.com` |
| GitHub — create privacy repo | https://github.com/new |
| GitHub Pages — your privacy URL (after Step 2) | https://luiscarlosricoalamda.github.io/kaigi-meeting-privacy/ |
| Gemini API key creation | https://aistudio.google.com/apikey |
| AnkiConnect add-on | https://ankiweb.net/shared/info/2055492159 |
