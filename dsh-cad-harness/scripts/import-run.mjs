#!/usr/bin/env node
// External-trajectory import: lib/import-run.js is built by esbuild; no src/ needed.
import { main } from '../lib/import-run.js';
process.exit(await main(process.argv.slice(2)));
