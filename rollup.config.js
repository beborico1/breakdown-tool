import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

// The content bundle is parsed and compiled once per frame, and the manifest
// injects it with all_frames + match_about_blank — and with universal mode on,
// into every frame of every site. Minifying cuts that per-frame cost directly.
const minify = () => terser({ format: { comments: false } });

export default [
  {
    input: 'src/content/index.js',
    output: {
      file: 'dist/content.js',
      format: 'iife',
      name: 'KaigiMeeting',
      sourcemap: false
    },
    plugins: [resolve(), minify()]
  },
  {
    input: 'src/background/service-worker.js',
    output: {
      file: 'dist/service-worker.js',
      format: 'iife',
      name: 'KaigiServiceWorker',
      sourcemap: false
    },
    plugins: [resolve(), minify()]
  },
  {
    input: 'src/offscreen/offscreen.js',
    output: {
      file: 'dist/offscreen.js',
      format: 'iife',
      name: 'KaigiOffscreen',
      sourcemap: false
    },
    plugins: [resolve({ browser: true }), minify()]
  }
];
