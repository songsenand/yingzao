// Build script: host half (ESM) + client half (ModuleLoader factory CJS).
import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';
import { argv } from 'node:process';

mkdirSync('lib', { recursive: true });

const watch = argv.includes('--watch');

// Host half: plain ESM, loaded by the cordis loader in the dsh process.
const host = await esbuild.context({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['@deepseek-ai/*', '@deepseek-ai/cordis', 'schemastery', 'manifold-3d'],
  sourcemap: true,
});

// Client half: CJS factory registered via window.__ModuleLoader__.load(),
// mirroring the first-party bundle shape exactly. react/jsx-runtime are
// baseline platform modules resolved from the module table.
const clientBanner = `window.__ModuleLoader__.load({
  id: "dsh-cad-harness",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`;
const clientFooter = `
    return module.exports;
  }
});
`;

const client = await esbuild.context({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-api-session-controller/client'],
  banner: { js: clientBanner },
  footer: { js: clientFooter },
  sourcemap: 'external',
  jsx: 'automatic',
});

if (watch) {
  await Promise.all([host.watch(), client.watch()]);
  console.log('[cad-harness] watching…');
} else {
  await Promise.all([host.rebuild(), client.rebuild()]);
  await Promise.all([host.dispose(), client.dispose()]);
  console.log('[cad-harness] built lib/index.js + lib/client.js');
}
