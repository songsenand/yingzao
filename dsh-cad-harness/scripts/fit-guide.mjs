// Print the fit interface guide (friction reducer, no tool execution).
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const guide = await readFile(join(ROOT, 'pearls/fit/INTERFACE-GUIDE.md'), 'utf8');
console.log(guide);
