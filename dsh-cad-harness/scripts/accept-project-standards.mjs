// The three examples are the acceptance matrix for project profile + fit:
//   roberval: full contract (26/0) -> pass
//   windup:   partial contract (14/9) -> pass + warn
//   table:    0 interfaces (0/47) -> blocked
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectProfile } from '../src/host/pearls/profile.ts';
import { observeFit } from '../src/host/pearls/observe.ts';
import { observeModel } from '../src/host/pearls/model.ts';
import { observeLedger } from '../src/host/pearls/ledger.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`); };

async function observe(rel) {
  const profile = await loadProjectProfile(join(ROOT, rel));
  const obs = await observeFit(join(profile.projectRoot, 'cad-data'), {
    requireUndeclaredZero: profile.undeclaredPolicy === 'block',
    template: profile.template,
  });
  const model = await observeModel(profile.projectRoot);
  const ledger = await observeLedger(profile.projectRoot, { template: profile.template, strictUndeclared: profile.undeclaredPolicy === 'block', make: profile.rulePack.manifest.make });
  return { profile, obs, model, ledger };
}

const rob = await observe('examples/roberval-balance');
check(rob.model.status === 'pass' && rob.model.counts?.interfaces === 26, 'roberval model: valid 26-interface contract', `${rob.model.status} ${JSON.stringify(rob.model.counts)}`);
check(rob.profile.rulePack.manifest.id === 'mechanism', 'roberval selects the mechanism rule pack');
check(rob.profile.template === 'mechanism', 'roberval uses fit/mechanism');
check(rob.obs.status === 'pass' && rob.obs.counts.interfaces === 26 && rob.obs.counts.undeclared === 0,
  'roberval: 26 interfaces / 0 undeclared -> pass', `${rob.obs.status} ${JSON.stringify(rob.obs.counts)}`);
check(rob.obs.failures.length === 0, 'roberval: no localized failures');
check(rob.ledger.brief.status === 'pass' && rob.ledger.model.status === 'pass' && rob.ledger.fit.status === 'pass', 'roberval ledger: brief/model/fit pass');
check(rob.ledger.make.status === 'warn' && rob.ledger.review.status === 'unobserved' && rob.ledger.deliver.status === 'fail', 'roberval ledger: make warn; review unobserved; deliver fail', `${rob.ledger.make.status}/${rob.ledger.review.status}/${rob.ledger.deliver.status}`);
check(rob.ledger.review.failures.every((f) => f.location.kind === 'part' && f.why.length > 0), 'roberval ledger: missing review evidence is localized');

const wind = await observe('examples/windup-frog');
check(wind.model.status === 'pass' && wind.model.counts?.interfaces === 14, 'windup model: valid 14-interface contract', `${wind.model.status} ${JSON.stringify(wind.model.counts)}`);
check(wind.profile.rulePack.manifest.id === 'mechanism', 'windup selects the mechanism rule pack');
check(wind.profile.template === 'mechanism', 'windup uses fit/mechanism');
check(wind.obs.status === 'pass' && wind.obs.findings.some((f) => f.code === 'undeclared-adjacency' && f.severity === 'warn'),
  'windup: 14 interfaces / 9 undeclared -> pass + warn', `${wind.obs.status} ${JSON.stringify(wind.obs.counts)}`);
check(wind.obs.failures.some((f) => f.code === 'undeclared-adjacency' && f.location.kind === 'pair' && !!f.location.center),
  'windup: undeclared contact is localized to a pair AABB', JSON.stringify(wind.obs.failures[0]?.location));
check(wind.ledger.make.status === 'warn' && wind.ledger.review.status === 'warn' && wind.ledger.deliver.status === 'warn', 'windup ledger: make/review/deliver warn', `${wind.ledger.make.status}/${wind.ledger.review.status}/${wind.ledger.deliver.status}`);

const table = await observe('examples/eight-immortals-table');
check(table.model.status === 'pass' && table.model.counts?.interfaces === 0, 'table model: an empty contract is valid for model, but not for fit', `${table.model.status} ${JSON.stringify(table.model.counts)}`);
check(table.profile.rulePack.manifest.id === 'wood-furniture', 'table selects the wood-furniture rule pack');
check(table.profile.template === 'static', 'table uses fit/static');
check(table.obs.status === 'blocked' && table.obs.findings.some((f) => f.code === 'no-declared-interfaces'),
  'table: 0 interfaces / 47 undeclared -> blocked, not green', `${table.obs.status} ${JSON.stringify(table.obs.counts)}`);
check(table.obs.failures.some((f) => f.code === 'no-declared-interfaces' && f.location.kind === 'manifest'),
  'table: empty contract failure points at the manifest');
check(table.obs.failures.some((f) => f.code === 'undeclared-adjacency' && f.location.kind === 'pair' && !!f.location.center),
  'table: undeclared contact is localized to a pair AABB', JSON.stringify(table.obs.failures.find((f) => f.code === 'undeclared-adjacency')?.location));
check(table.ledger.make.status === 'pass' && table.ledger.review.status === 'pass' && table.ledger.deliver.status === 'fail', 'table ledger: wood stock fits; review pass; deliver fail', `${table.ledger.make.status}/${table.ledger.review.status}/${table.ledger.deliver.status}`);
check(table.ledger.overall === 'blocked', 'table ledger: overall is blocked by fit');
check(table.profile.undeclaredPolicy === 'block', 'table rule pack opts into strict policy');

const empty = await mkdtemp(join(tmpdir(), 'model-empty-'));
const noContract = await observeModel(empty);
check(noContract.status === 'blocked' && noContract.issues.length > 0, 'model blocks a project with no assembly contract', noContract.issues[0]?.slice(0, 80));
check(noContract.failures.length > 0 && noContract.failures[0].location.kind === 'manifest', 'model failure carries a manifest location');
await rm(empty, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
