// Build the sandbox panel bundle: the real CadPanel, self-contained (React is
// bundled, not taken from the platform module table) so it can run in a plain
// page served by sandbox/preview/server.mjs.
//
//   node sandbox/preview/build.mjs [--watch]
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { argv } from 'node:process';

// react-dom is not a dependency of this plugin (the real GUI provides it via the
// platform module table), so for the sandbox we borrow a matching pair.
const JUPYTER = '/home/songsenand/env/.venv/share/jupyter/lab/staging/node_modules';
const alias = {};
for (const [from, to] of [
  ['react', `${JUPYTER}/react`],
  ['react/jsx-runtime', `${JUPYTER}/react/jsx-runtime.js`],
  ['react/jsx-dev-runtime', `${JUPYTER}/react/jsx-dev-runtime.js`],
  ['react-dom', `${JUPYTER}/react-dom`],
  ['react-dom/client', `${JUPYTER}/react-dom/client.js`],
]) {
  if (existsSync(to)) alias[from] = to;
  else console.warn(`[sandbox] missing alias target for ${from}: ${to}`);
}

const opts = {
  entryPoints: ['sandbox/preview/entry.tsx'],
  outfile: 'sandbox/preview/dist/bundle.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  alias,
  sourcemap: 'inline',
  logLevel: 'info',
};

if (argv.includes('--watch')) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('[sandbox] watching panel bundle…');
} else {
  await esbuild.build(opts);
  console.log('[sandbox] built sandbox/preview/dist/bundle.js');
}
