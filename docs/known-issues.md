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

## 3. Joining a word swallows the click from the page

When a plain click on a coloured word is taken as a join, the handler stops it: the page sees no
click at all, so a document-level delegated handler ("close the open menu", a framework root's
synthetic click) does not run for it.

`isInsideInteractive` (`src/content/shared/word-island.js`) hands the click back for links,
buttons, form controls, and anything under an ancestor with a pointer cursor, which covers the
cases where the site clearly owns the click. Delegation at the document has no such signal to read.
The alternative, letting the click through, is not obviously better: on a site that puts a handler
on the article body, every word joined would also fire whatever that handler does.

Surface: `onClick` in `src/content/shared/word-island.js`.
Impact: while joining words, a menu or popover the site opened may need a second click to dismiss.
