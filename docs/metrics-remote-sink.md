# Sending metrics off-device (not implemented)

v2.0.0 stores metrics **only** on the user's own machine. Nothing is transmitted, there is no
endpoint, and no code in the shipped package can send a metric anywhere. The Insights page shows
everything that is stored and has a button that deletes all of it.

This file records what turning that into a remote sink would require, so the work is a known
quantity rather than a rewrite. It is deliberately kept **out of the packaged extension** (the
packaging allowlist excludes `.md`): a commented-out exfiltration plan sitting inside a package
whose data-usage disclosure says "no data collected" reads badly to a store reviewer, and rightly so.

## What already exists

- `src/metrics/events.js` — the frozen registry. The API takes no free-form argument, and
  `count()` drops any name or dimension not in the registry at runtime, so no URL, hostname,
  page title, or analyzed text can become an event.
- `src/metrics/index.js` — per-context spool, batched to the service worker.
- `src/metrics/sink-local.js` — the single writer, daily buckets, 90-day prune.
- `meta.installId` — a random UUID minted once per install. It exists so a future sink could
  deduplicate one install's reports. **Nothing reads it today.**

## What adding a remote sink would require

1. **Consent before anything leaves.** The current privacy policy states plainly that metrics stay
   on the device. Shipping a sink without an explicit opt-in would make that statement false for
   existing users, so it needs a first-run choice, defaulting to off, and a switch to turn it back off.
2. **A host permission** for the endpoint, added to `manifest.json`. This is reviewable, and the
   store listing's permission justification has to explain it.
3. **Privacy policy and data-usage disclosure rewrites.** "No analytics, no telemetry" becomes
   false; the disclosure form answers change materially.
4. **Batching, retry and backoff** in a new `sink-remote.js`, plus a cap on how much is buffered
   when the endpoint is unreachable.
5. **Egress must route through the service worker.** Content scripts on strict-CSP pages
   (meet.google.com) cannot fetch at all — see the comment at the top of `service-worker.js`.
   The fetch proxy's `ALLOWED_FETCH_ORIGINS` would need the endpoint added.
6. **Keep the registry as the boundary.** The temptation when a real endpoint exists is to add "just
   one" free-form field. `core/cache.js` `generateContentKey()` embeds the speaker name and sits one
   line from the cache counters — that is exactly how a meeting participant's name would end up in a
   payload. The no-payload API shape is what prevents it.
