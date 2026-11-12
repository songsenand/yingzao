#!/usr/bin/env node
// Packaged verify: lib/verify.js is built by esbuild; no src/ or tsx needed.
import { main } from '../lib/verify.js';
process.exit(await main(process.argv.slice(2)));
