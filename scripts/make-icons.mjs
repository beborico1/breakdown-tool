#!/usr/bin/env node
// Rasterise assets/source/icon.svg into the four PNG sizes the manifest declares.
//
// Playwright rather than ImageMagick: `magick svg:-` renders shapes fine but fails on
// <text> for lack of a font, and its internal SVG renderer handles strokes and corner
// radii less faithfully than a browser does. Chromium is already installed for the
// test suites, so this adds no dependency.
//
// Deliberately NOT wired into `npm run build`. Committed art should only change when
// someone means to change it, not as a side effect of every build.

import { chromium } from 'playwright';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'assets/source/icon.svg');
const OUT_DIR = path.join(ROOT, 'assets/icons');
/**
 * Per-size optical correction, applied to the master before rasterising.
 *
 * `inset` is the tile margin in viewBox units (of 128); `stroke` is the glyph stroke
 * width in the same units. Both have to grow relatively as the output shrinks: at
 * 16x16 the whole icon is ~256 pixels, so the master's 16-unit margin costs a quarter
 * of the width and its 7.5-unit stroke lands under one real pixel, which closes the
 * bowl of the glyph into a blob. Verified by rendering and looking, not by theory.
 */
const SIZES = [
  { size: 16, inset: 3, stroke: 13 },
  { size: 32, inset: 8, stroke: 10 },
  { size: 48, inset: 12, stroke: 8.5 },
  { size: 128, inset: 16, stroke: 7.5 },
];

const svg = await readFile(SRC, 'utf8');

const browser = await chromium.launch();
try {
  for (const { size, inset, stroke } of SIZES) {
    // deviceScaleFactor has to be set on the context, not the page — a persistent
    // or per-page override is ignored. Rendering at 1x into an exactly-sized box is
    // enough here because the source is vector.
    const ctx = await browser.newContext({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.setContent(
      `<style>
         html,body{margin:0;padding:0;background:transparent}
         #a{width:${size}px;height:${size}px;display:block}
         #a svg{width:100%;height:100%;display:block}
       </style>
       <div id="a">${svg}</div>`,
      { waitUntil: 'load' }
    );

    // Apply the optical correction in the DOM rather than by string-patching the SVG,
    // so a change to the master's formatting cannot silently stop it applying.
    await page.evaluate(({ inset, stroke }) => {
      const tile = document.getElementById('tile');
      tile.setAttribute('x', String(inset));
      tile.setAttribute('y', String(inset));
      tile.setAttribute('width', String(128 - inset * 2));
      tile.setAttribute('height', String(128 - inset * 2));
      // Keep the corner radius proportional to the tile, or a near-full-bleed small
      // tile ends up looking squarer than the large one.
      tile.setAttribute('rx', String(Math.round((128 - inset * 2) * 0.229)));
      document.getElementById('glyph').setAttribute('stroke-width', String(stroke));
    }, { inset, stroke });

    // omitBackground keeps the alpha channel; without it the PNG gets an opaque
    // white backdrop and the icon reads as a white square on a dark toolbar.
    const buf = await (await page.$('#a')).screenshot({ omitBackground: true });
    const out = path.join(OUT_DIR, `icon${size}.png`);
    await writeFile(out, buf);
    await ctx.close();

    // Verify the raster is exactly the requested size by parsing the IHDR rather
    // than trusting the screenshot call: a mismatch here would ship a blurry icon.
    const { width, height, colourType } = readIhdr(buf);
    const ok = width === size && height === size;
    console.log(
      `  ${ok ? '✓' : '✗'} icon${size}.png  ${width}x${height}  ` +
      `colour type ${colourType}${colourType === 6 ? ' (RGBA)' : ''}  ` +
      `${(buf.length / 1024).toFixed(1)} KB`
    );
    if (!ok) {
      console.error(`    expected ${size}x${size}`);
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
}

/** Parse a PNG's IHDR chunk. Bytes 16-24 are width, height, depth, colour type. */
function readIhdr(buf) {
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colourType: buf[25],
  };
}

// The manifest declares all four sizes and packaging hard-fails on a missing one,
// so an incomplete run is worth catching here rather than at package time.
for (const { size } of SIZES) {
  const p = path.join(OUT_DIR, `icon${size}.png`);
  await stat(p).catch(() => {
    console.error(`missing output ${p}`);
    process.exitCode = 1;
  });
}
