import resolve from '@rollup/plugin-node-resolve';

export default [
  // Existing content script bundle
  {
    input: 'src/content/index.js',
    output: {
      file: 'dist/content.js',
      format: 'iife',
      name: 'KaigiMeeting',
      sourcemap: false
    },
    plugins: [resolve()]
  },
  // Service worker
  {
    input: 'src/background/service-worker.js',
    output: {
      file: 'dist/service-worker.js',
      format: 'iife',
      name: 'KaigiServiceWorker',
      sourcemap: false
    },
    plugins: [resolve()]
  },
  // Offscreen document
  {
    input: 'src/offscreen/offscreen.js',
    output: {
      file: 'dist/offscreen.js',
      format: 'iife',
      name: 'KaigiOffscreen',
      sourcemap: false
    },
    plugins: [resolve()]
  },
  // Audio mode content script (injected programmatically)
  {
    input: 'src/content/audio-entry.js',
    output: {
      file: 'dist/audio-content.js',
      format: 'iife',
      name: 'KaigiAudio',
      sourcemap: false
    },
    plugins: [resolve()]
  }
];
