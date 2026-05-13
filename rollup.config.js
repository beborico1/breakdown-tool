import resolve from '@rollup/plugin-node-resolve';

export default [
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
  {
    input: 'src/offscreen/offscreen.js',
    output: {
      file: 'dist/offscreen.js',
      format: 'iife',
      name: 'KaigiOffscreen',
      sourcemap: false
    },
    plugins: [resolve({ browser: true })]
  }
];
