#!/usr/bin/env node
// Build the public site published to GitHub Pages: a landing page and the privacy
// policy, both generated from the Markdown that already lives in the repo.
//
// Generated rather than hand-maintained so the published policy cannot drift from
// PRIVACY_POLICY.md — the store form links to one and a reviewer reads the other.
//
// Only site/ is published (see .github/workflows/pages.yml). That is deliberate: a
// root-source Pages site would also serve SUBMISSION_GUIDE.md and CLAUDE.md, which
// contain local filesystem paths and a contact address, on the same host as the
// privacy policy.
//
// Usage:  npm run site

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'site');

const PURPLE = '#632889';

/**
 * Minimal Markdown -> HTML. Deliberately not a dependency: the only input is
 * PRIVACY_POLICY.md, which is 127 lines of plain GFM with no links, no raw HTML and
 * one pipe table. A general parser would be more code to audit than this is.
 */
function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let inList = false;

  const inline = (s) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  while (i < lines.length) {
    const line = lines[i];

    // Table: a header row followed by a |---| separator.
    if (line.startsWith('|') && (lines[i + 1] || '').replace(/[\s|:-]/g, '') === '') {
      closeList();
      const cells = (r) => r.split('|').slice(1, -1).map(c => inline(c.trim()));
      out.push('<table><thead><tr>' +
        cells(line).map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && lines[i].startsWith('|')) {
        out.push('<tr>' + cells(lines[i]).map(c => `<td>${c}</td>`).join('') + '</tr>');
        i++;
      }
      out.push('</tbody></table>');
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      // Join continuation lines so a wrapped bullet is one <li>.
      let text = bullet[1];
      while (/^\s{2,}\S/.test(lines[i + 1] || '')) { text += ' ' + lines[++i].trim(); }
      out.push(`<li>${inline(text)}</li>`);
      i++;
      continue;
    }

    if (line.trim() === '') { closeList(); i++; continue; }

    // Paragraph: absorb following non-blank, non-structural lines.
    closeList();
    let para = line.trim();
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.trim() === '' || /^(#{1,4})\s/.test(next) || /^[-*]\s/.test(next) || next.startsWith('|')) break;
      para += ' ' + next.trim();
      i++;
    }
    out.push(`<p>${inline(para)}</p>`);
    i++;
  }
  closeList();
  return out.join('\n');
}

const CSS = `
  :root { --ink:#1f2328; --muted:#5f6368; --brand:${PURPLE}; --line:#e8e8ea; }
  * { box-sizing:border-box }
  body {
    margin:0; background:#fff; color:var(--ink); line-height:1.65;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  }
  .wrap { max-width:720px; margin:0 auto; padding:40px 24px 80px }
  .site-head { border-bottom:1px solid var(--line); background:#fff }
  .site-head .wrap { display:flex; align-items:center; gap:10px; padding:14px 24px }
  .site-head img { width:26px; height:26px }
  .site-head a { color:var(--ink); text-decoration:none; font-weight:600; font-size:15px }
  h1 { font-size:30px; line-height:1.25; letter-spacing:-.02em; margin:0 0 10px }
  h2 { font-size:19px; margin:34px 0 10px; letter-spacing:-.01em }
  h3 { font-size:15px; margin:24px 0 8px; color:var(--ink) }
  p, li { font-size:15px }
  a { color:var(--brand) }
  code {
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.88em;
    background:#f5f4f7; padding:.12em .34em; border-radius:4px;
  }
  table { border-collapse:collapse; width:100%; margin:14px 0; font-size:14px; display:block; overflow-x:auto }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top }
  th { font-weight:600; background:#faf9fb }
  .lede { font-size:17px; color:var(--muted); margin:0 0 26px }
  .foot { margin-top:52px; padding-top:18px; border-top:1px solid var(--line); font-size:13px; color:var(--muted) }
  .hero { text-align:center; padding:26px 0 8px }
  .hero img { width:88px; height:88px }
  .shot { width:100%; border:1px solid var(--line); border-radius:10px; margin:22px 0 }
  .cta {
    display:inline-block; background:var(--brand); color:#fff; text-decoration:none;
    padding:10px 20px; border-radius:8px; font-weight:500; font-size:15px;
  }
  .points { padding-left:20px }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e8eaed; --muted:#9aa0a6; --line:#33363a }
    body, .site-head, th { background:#1b1c1e }
    code { background:#2a2c2f }
    .site-head a { color:var(--ink) }
  }
`;

function page({ title, description, body, canonicalNav = true }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="icon" href="icon.png">
<style>${CSS}</style>
</head>
<body>
${canonicalNav ? `<header class="site-head"><div class="wrap">
  <img src="icon.png" alt=""><a href="./">Japanese in Color</a>
</div></header>` : ''}
<main class="wrap">
${body}
<div class="foot">
  <a href="./">Home</a> &middot; <a href="privacy.html">Privacy</a> &middot;
  <a href="https://github.com/beborico1/japanese-in-color">Source</a>
</div>
</main>
</body>
</html>
`;
}

await mkdir(OUT, { recursive: true });

// The policy, verbatim from the file the repo already maintains.
const policyMd = await readFile(path.join(ROOT, 'PRIVACY_POLICY.md'), 'utf8');
await writeFile(
  path.join(OUT, 'privacy.html'),
  page({
    title: 'Privacy Policy — Japanese in Color',
    description: 'What Japanese in Color does with your data. The text on your pages is analyzed on your computer and is never uploaded.',
    body: renderMarkdown(policyMd),
  })
);

// The landing page. Its only job is to be a real home for the privacy link and to
// say what the extension is.
await writeFile(
  path.join(OUT, 'index.html'),
  page({
    canonicalNav: false,
    title: 'Japanese in Color — color every Japanese word by its part of speech',
    description: 'A Chrome extension that colors every Japanese word on the web by its part of speech, with readings and meanings. Free, private, runs on your computer.',
    body: `
<div class="hero">
  <img src="icon.png" alt="">
  <h1>Japanese in Color</h1>
  <p class="lede">Every Japanese word on the web, colored by the job it does in the sentence.</p>
</div>

<img class="shot" src="screenshot.png"
     alt="A Japanese article with each word colored by part of speech, and a tooltip showing a word's reading and meaning.">

<p>Turn it on and any page with Japanese on it gets colored by part of speech — nouns,
verbs, particles, adjectives — so the shape of a sentence is visible before you have
parsed a single word. Hover any word for its reading, romaji and meaning.</p>

<ul class="points">
  <li><strong>Runs on your computer.</strong> A Japanese tokenizer and dictionaries are
      bundled in. No account, no sign-in, no API key.</li>
  <li><strong>Your words.</strong> Everything you look up is collected into a searchable
      list you can send to Anki.</li>
  <li><strong>You stay in control.</strong> Ships switched off, pauses per site, and
      releases its permission when you switch it off.</li>
</ul>

<h2>Privacy in one line</h2>
<p>The text on the pages you read is analyzed on your computer and is never uploaded.
Usage statistics stay on your machine. <a href="privacy.html">Read the full policy.</a></p>
`,
  })
);

// Icon and a lead screenshot, copied so the site has no external dependencies.
await copyFile(path.join(ROOT, 'assets/icons/icon128.png'), path.join(OUT, 'icon.png'));
await copyFile(
  path.join(ROOT, 'assets/store-screenshots/1-article-word-tooltip.png'),
  path.join(OUT, 'screenshot.png')
);

console.log('site/ built: index.html, privacy.html, icon.png, screenshot.png');
