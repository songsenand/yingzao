#!/usr/bin/env node
// Packaged custom-check CLI: lib/check-register.js is built by esbuild; no src/
// or tsx needed on a clean install.
import { main } from '../lib/check-register.js';
process.exit(await main(process.argv.slice(2)));
