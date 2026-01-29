# Session Summary: MutationObserver Infinite Loop

## Project

**google-meet-caption-copier** — A Chrome extension that copies and translates Google Meet captions using the Gemini 2.5 Flash API. It uses a `MutationObserver` to watch for DOM changes and a "fight loop" to protect translated elements from being overwritten by Google Meet's own DOM management.

---

## The Problem

After clicking a caption to translate it, the browser would freeze or become extremely sluggish. The DevTools console would flood with log entries. The extension's `MutationObserver` callback was firing hundreds of times per second in an infinite loop.

---

## What We Did

### Phase 1: Diagnostic Instrumentation

Added debug logging throughout `content.js` to identify the root cause:

1. **Observer rate-limit detection** — A counter that tracks how many times the observer fires per second. Logs a `LOOP-DETECT` warning when it exceeds 50 calls/sec.
2. **Fight loop action logging** — Each of the three "fight" actions (A, B, C) now logs when it fires, including what it's doing and why.
3. **Mutation type logging** — Logs `characterData` mutations specifically, since those were a suspected amplifier.
4. **API call counter** — Numbered API calls (`Call #1`, `Call #2`, etc.) to confirm the Gemini API was not being called in the loop.

### Phase 2: Root Cause Confirmed via Debug Output

We loaded the instrumented extension and reproduced the bug. The console output showed:

- **`FIGHT-A` and `FIGHT-B` alternate endlessly** in a tight loop
- **`FIGHT-C` never fires** — text overwriting is not part of the loop
- **`LOOP-DETECT` fires** — confirming >50 observer invocations per second
- **API calls are safe** — only fire on explicit user clicks, never from the observer

The cycle:

```
FIGHT-A: We remove Meet's re-inserted original element
  → childList mutation enqueued
  → observer re-fires
FIGHT-B: Our translated element got dislodged, we re-append it
  → childList mutation enqueued
  → observer re-fires
  → back to FIGHT-A
  → repeat forever
```

### Phase 3: Fix Design and Evaluation

We evaluated three approaches:

| Approach | Verdict | Why |
|---|---|---|
| **Disconnect/Reconnect** | **Chosen** | Bulletproof — zero chance of self-triggered mutations. The disconnect window is synchronous (microseconds), so no real Meet mutations can be missed (JS is single-threaded). |
| Guard flag (`isSelfMutating`) | Rejected | MutationObserver callbacks fire after microtasks drain, not synchronously. The flag would already be cleared when the re-triggered callback runs. |
| CSS hiding (`display:none`) | Rejected | Avoids childList mutations for FIGHT-A, but FIGHT-B still needs `appendChild`, which is a childList mutation. Only a partial fix. |

### Phase 4: Implementation

Applied 3 edits to `content.js`:

1. **Extracted `OBSERVER_CONFIG`** — A reusable constant so the observer config isn't duplicated between `initializeObserver()` and the reconnect call.

2. **Used `OBSERVER_CONFIG` in `initializeObserver()`** — Replaced inline config object.

3. **Wrapped the fight loop with lazy disconnect/reconnect** — A `didFight` flag ensures `observer.disconnect()` is called exactly once, right before the first DOM modification. After the loop finishes all fighting, `observer.observe()` reconnects. Our DOM changes happen while the observer is not listening, so they cannot re-trigger the callback.

---

## What We Did NOT Do

- **Did not remove the debug logging.** The `LOOP-DETECT`, `FIGHT-A/B/C`, `MUTATION-TYPE`, and API counter logs are still in place. This is intentional — they're useful for verifying the fix works and for diagnosing future issues. `DEBUG = true` can be set to `false` to silence them.
- **Did not test the fix in a live Google Meet session.** The fix was implemented based on the confirmed diagnosis; live verification is the next step.
- **Did not address whether `characterData: true` is actually needed.** The debug logs showed no `MUTATION-TYPE` entries for `characterData`, suggesting it might be unnecessary. Removing it could reduce observer noise but was out of scope.
- **Did not optimize the fight loop itself.** The approach of removing/re-inserting elements works but is adversarial — a future improvement could explore cooperating with Meet's DOM updates rather than fighting them.
- **Did not commit the changes.** The working tree has uncommitted modifications to `content.js`.

---

## What We Learned

### Technical Findings

1. **MutationObserver callbacks are NOT microtasks.** They fire in the browser's "notify mutation observers" step, which runs after all microtasks drain. This means a synchronous guard flag (`isSelfMutating = true; doWork(); isSelfMutating = false;`) does NOT prevent re-entry — the flag is already cleared by the time the re-triggered callback runs.

2. **`disconnect()` is the only reliable way to suppress self-triggered mutations.** Since DOM modifications within the callback synchronously enqueue mutation records, and the callback will re-fire after it returns, the only way to prevent the loop is to not be listening during the modifications.

3. **The disconnect window is safe.** JavaScript is single-threaded. Between `observer.disconnect()` and `observer.observe()`, no other code (including Meet's scripts) can run. The only mutations that could be "missed" are ones we deliberately caused ourselves — which is exactly what we want.

4. **Meet reactively rebuilds caption DOM.** When the extension removes Meet's original caption element, Meet detects this and re-inserts a new one (possibly rebuilding the entire caption container). This is what creates the adversarial loop — both sides are reacting to each other's DOM changes.

5. **FIGHT-C (text restoration) was not involved.** Despite being a suspected contributor (since `textContent =` creates childList mutations on text nodes), it never fired during the loop. The loop is purely structural (element insertion/removal), not textual.

6. **The Gemini API was never called in the loop.** The API call counter confirmed that `translateWithGemini()` only fires from `handleCaptionClick()`, never from the observer. This was an important finding that narrowed the diagnosis to the DOM fight loop exclusively.

### Theories

- **Why Meet re-inserts the original:** Google Meet likely uses its own MutationObserver or framework-level reactivity (possibly Angular/Lit) to keep the caption DOM in sync with its internal state. When we remove an element, Meet's framework detects the discrepancy and reconciles by re-creating the element.
- **Why the loop is so fast:** Both observers (ours and Meet's) react within the same event loop. Our removal triggers Meet's re-insertion, which triggers our removal, all within microseconds. There's no natural debounce.

---

## Errors Encountered During Development

| Error | Status | Resolution |
|---|---|---|
| Infinite observer loop (FIGHT-A/B cycle) | **Fixed** | Disconnect/reconnect around DOM modifications |
| Browser tab freezing during translation | **Fixed** (same root cause) | Same fix — the freeze was caused by the CPU-bound infinite loop |
| No issues with the diagnostic logging edits | N/A | All 5 debug edits applied cleanly |

---

## Next Steps

1. **Verify the fix** — Load the updated extension in Chrome, open a Google Meet with captions, click a caption to translate, and confirm:
   - `LOOP-DETECT` no longer fires
   - `FIGHT-A` / `FIGHT-B` fire once or twice and stop (not endlessly)
   - Translated text remains visible and stable
   - New captions from other speakers still get click handlers (observer reconnects correctly)

2. **Set `DEBUG = false`** — Once the fix is verified, disable debug logging for production use to avoid console noise.

3. **Consider removing `characterData: true`** — The observer config watches for character data changes, but debug logs suggest this isn't needed. Removing it would reduce the number of mutations the observer processes.

4. **Consider a less adversarial approach** — Instead of removing Meet's elements and fighting re-insertions, a future refactor could hide them with CSS (`display: none`) and overlay the translation. This would avoid `childList` mutations entirely for FIGHT-A and might eliminate the need for the fight loop altogether. FIGHT-B (re-insertion after dislodgement) would still need the disconnect/reconnect pattern.

5. **Commit the changes** — Once verified, commit the debug instrumentation + fix as a single commit or split into two (diagnosis, then fix).

---

## Files Modified

| File | Changes |
|---|---|
| `content.js` | Added debug instrumentation (rate-limit detection, fight logging, mutation type logging, API counter). Added `OBSERVER_CONFIG` constant. Wrapped fight loop with disconnect/reconnect to fix infinite loop. |

## Git Status

- Branch: `main`
- Uncommitted changes: `content.js` (modified)
- Last commit: `834d065 new icon`
