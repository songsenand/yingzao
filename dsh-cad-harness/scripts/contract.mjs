#!/usr/bin/env node
// Packaged entry: lib/contract-cli.js is built by esbuild; a development
// checkout falls back to the TypeScript source (Node 22+ type stripping).
let main;
try {
  ({ main } = await import('../lib/contract-cli.js'));
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  ({ main } = await import('../src/host/contract-cli.ts'));
}
process.exit(await main(process.argv.slice(2)));
