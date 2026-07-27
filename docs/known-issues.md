# Known issues

Open defects carried over from the pre-2.0 planning notes. Neither blocks the Chrome Web Store
submission, because the reviewer-facing smoke test is now the all-sites flow rather than a Meet
caption click.

## 1. Meet captions turn gray when the transcriber revises a colorized sentence

Google Meet's built-in transcriber sometimes rewrites a sentence *after* the colorizer has already
painted it. When that happens the repaint breaks: most of the text collapses to gray, with a few
colored words surviving.

Surface: `src/content/meet/` (the minimalistic incremental path).
Impact: the whole caption rail becomes unreadable for the rest of the utterance.

## 2. Gmail: reverting to the original after a partial analysis misbehaves

After analyzing one section of a Gmail message, using "back to the original" on that message leaves
the DOM in an inconsistent state.

Surface: `src/content/gmail/`, and the `gcwb-content-restored` restore path.
Impact: the message has to be re-opened to recover.
