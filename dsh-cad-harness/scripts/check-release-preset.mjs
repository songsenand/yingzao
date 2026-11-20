#!/usr/bin/env node
// Release-preset gate that does not depend on this checkout's absolute skill
// path. `prepack` always regenerates the tarball preset WITHOUT skills; the old
// `prepublishOnly` compared the committed dev preset (with /home/...) and could
// only pass on the machine that last ran setup. This checks the same packed
// shape against the installed dsh standard.patch.yml instead.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreset } from './preset-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const built = buildPreset({ root: ROOT, withoutSkills: true });
  if (!built.text.includes('modelSelection')) {
    console.error('check-release-preset: generated preset is missing modelSelection; dsh standard changed');
    process.exit(1);
  }
  if (/^\s*-\s*\/home\//m.test(built.text)) {
    console.error('check-release-preset: packed preset leaked an absolute /home path');
    process.exit(1);
  }
  console.log(`check-release-preset: ok (${built.rows} rows, source ${built.source})`);
} catch (error) {
  console.error(`check-release-preset: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
