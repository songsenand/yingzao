// Print the six-pearl read-only ledger for one project profile.
import { loadProjectProfile } from '../src/host/pearls/profile.ts';
import { observeLedger } from '../src/host/pearls/ledger.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/pearl-ledger.mjs <project-dir>');
  process.exit(2);
}
const profile = await loadProjectProfile(dir);
const ledger = await observeLedger(profile.projectRoot, {
  template: profile.template,
  strictUndeclared: profile.undeclaredPolicy === 'block',
  make: profile.rulePack.manifest.make,
});
console.log(JSON.stringify({
  profile: profile.manifest.id,
  rulePack: profile.rulePack.manifest.id,
  ledger,
}, null, 2));
