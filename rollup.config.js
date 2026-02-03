import resolve from '@rollup/plugin-node-resolve';

export default {
  input: 'src/content/index.js',
  output: {
    file: 'dist/content.js',
    format: 'iife',
    name: 'KaigiMeeting',
    sourcemap: false
  },
  plugins: [
    resolve()
  ]
};
