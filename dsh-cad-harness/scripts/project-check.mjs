// Run one pearl observation for a project profile (no tool execution).
import { join } from 'node:path';
import { loadProjectProfile } from '../src/host/pearls/profile.ts';
import { observeFit } from '../src/host/pearls/observe.ts';
import { observeModel } from '../src/host/pearls/model.ts';
import { observeLedger } from '../src/host/pearls/ledger.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/project-check.mjs <project-dir>');
  process.exit(2);
}
const profile = await loadProjectProfile(dir);
const model = await observeModel(profile.projectRoot);
const fit = await observeFit(join(profile.projectRoot, 'cad-data'), {
  requireUndeclaredZero: profile.undeclaredPolicy === 'block',
  template: profile.template,
});
console.log(JSON.stringify({
  profile: profile.manifest.id,
  rulePack: profile.rulePack.manifest.id,
  template: profile.template,
  undeclaredPolicy: profile.undeclaredPolicy,
  model,
  fit,
  ledger: await observeLedger(profile.projectRoot, { template: profile.template, strictUndeclared: profile.undeclaredPolicy === 'block', make: profile.rulePack.manifest.make }),
}, null, 2));
