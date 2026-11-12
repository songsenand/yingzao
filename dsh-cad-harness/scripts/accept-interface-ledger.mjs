#!/usr/bin/env node
// Acceptance: per-interface evidence ledger (verify/interfaces.ts).
//
//   node scripts/accept-interface-ledger.mjs
//
// Pure input, no CAD and no project store: the ledger joins a manifest with a
// run entry + a report. Each case names the observation that would falsify it.

import { buildInterfaceLedger } from '../src/host/verify/interfaces.ts';
import { citedRunId } from '../src/host/evidence-pointer.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const manifest = (interfaces, children = []) => ({
  schemaVersion: 1,
  name: 'ledger-probe',
  unit: 'mm',
  up: 'z',
  root: {
    id: 'machine',
    kind: 'assembly',
    children: [
      { id: 'base', kind: 'part', name: 'base', version: 'v001' },
      { id: 'beam', kind: 'part', name: 'beam', version: 'v002' },
      ...children,
    ],
    interfaces,
  },
});

const run = (over = {}) => ({
  id: 'r002',
  kind: 'assembly-check',
  timestamp: '2026-01-02T00:00:00.000Z',
  sourceVersionIds: ['v001', 'v002'],
  ...over,
});

const report = (results, over = {}) => ({
  results,
  summary: { interfaces: results.length },
  ...over,
});

const times = new Map([
  ['v001', '2026-01-01T00:00:00.000Z'],
  ['v002', '2026-01-01T00:00:00.000Z'],
]);

const base = {
  assembly: manifest([
    { id: 'I1', a: 'base.top', b: 'beam.bottom', severity: 'hard', check: 'distance' },
    { id: 'I2', a: 'base.axis', b: 'beam.axis', severity: 'hard', check: 'coaxial' },
  ]),
  currentVersionSet: ['v001', 'v002'],
  versionTimes: times,
};

// 1) fresh run: verdicts map to proof statuses -----------------------------
{
  const ledger = await buildInterfaceLedger({
    ...base,
    runs: [run()],
    readReport: async () => report([
      { interfaceId: 'I1', ownerPath: ['machine'], verdict: 'pass' },
      { interfaceId: 'I2', ownerPath: ['machine'], verdict: 'hard-violation' },
    ]),
  });
  check(ledger.fresh === true && ledger.runId === 'r002', 'fresh run is selected', `${ledger.runId}/${ledger.fresh}`);
  check(ledger.counts.pass === 1 && ledger.counts.fail === 1, 'pass + hard-violation are separate counts',
    JSON.stringify(ledger.counts));
  check(ledger.counts.unproven === 0, 'no interface is unproven when every result exists');
  check(ledger.parts === 2 && ledger.total === 2, 'the ledger counts parts and interfaces itself',
    `${ledger.parts} parts / ${ledger.total} interfaces`);
  check(ledger.items.find((i) => i.id === 'I2')?.verdict === 'hard-violation', 'raw verdict is preserved');
}

// 2) stale run: nothing is proven ------------------------------------------
{
  const ledger = await buildInterfaceLedger({
    ...base,
    runs: [run({ sourceVersionIds: ['v001'] })],
    readReport: async () => report([{ interfaceId: 'I1', verdict: 'pass' }]),
  });
  check(ledger.fresh === false, 'a run on a different version set is not fresh');
  check(ledger.counts.unproven === 2, 'stale run proves nothing', JSON.stringify(ledger.counts));
  check(/version set|current set/.test(ledger.reason ?? ''), 'stale reason names the version set', ledger.reason);
}

// 3) manifest grew after the run: the new interface is unproven -------------
{
  const ledger = await buildInterfaceLedger({
    ...base,
    runs: [run()],
    readReport: async () => report([{ interfaceId: 'I1', ownerPath: ['machine'], verdict: 'pass' }]),
  });
  check(ledger.counts.pass === 1 && ledger.counts.unproven === 1, 'an interface added after the run is unproven',
    JSON.stringify(ledger.counts));
  check(/no result/.test(ledger.items.find((i) => i.id === 'I2')?.reason ?? ''), 'unproven names the missing result');
}

// 4) orphan results are counted, not attached -------------------------------
{
  const ledger = await buildInterfaceLedger({
    ...base,
    runs: [run()],
    readReport: async () => report([
      { interfaceId: 'I1', ownerPath: ['machine'], verdict: 'pass' },
      { interfaceId: 'I2', ownerPath: ['machine'], verdict: 'pass' },
      { interfaceId: 'I9', ownerPath: ['machine'], verdict: 'pass' },
    ]),
  });
  check(ledger.orphans === 1, 'a result with no manifest interface is an orphan', String(ledger.orphans));
  check(ledger.counts.pass === 2, 'orphans do not inflate pass counts');
}

// 5) no run at all ---------------------------------------------------------
{
  const ledger = await buildInterfaceLedger({ ...base, runs: [], readReport: async () => null });
  check(ledger.runId === null && ledger.fresh === false, 'no run keeps the ledger empty');
  check(ledger.counts.unproven === 2, 'no run means every interface is unproven');
  check(ledger.items.every((i) => i.reason === 'no assembly-check run'), 'reason is explicit, never a silent pass');
}

// 6) newest fresh run wins over newer stale one -----------------------------
{
  const ledger = await buildInterfaceLedger({
    ...base,
    runs: [
      run({ id: 'r003', timestamp: '2026-01-03T00:00:00.000Z', sourceVersionIds: ['v001'] }),
      run({ id: 'r002', timestamp: '2026-01-02T00:00:00.000Z' }),
    ],
    readReport: async (id) => (id === 'r002'
      ? report([{ interfaceId: 'I1', verdict: 'pass' }, { interfaceId: 'I2', verdict: 'pass' }])
      : report([])),
  });
  check(ledger.runId === 'r002' && ledger.fresh === true, 'a fresh older run beats a stale newer one', String(ledger.runId));
}

// 7) declared external evidence is carried, not required -------------------
{
  const ledger = await buildInterfaceLedger({
    assembly: manifest([
      { id: 'I1', a: 'base.top', b: 'beam.bottom', severity: 'hard', check: 'motion-clearance', params: { runId: 'r009' } },
      { id: 'I2', a: 'base.axis', b: 'beam.axis', severity: 'hard', evidence: { runId: 'r010' } },
    ]),
    currentVersionSet: ['v001', 'v002'],
    versionTimes: times,
    runs: [],
    readReport: async () => null,
  });
  check(ledger.items[0].declaredRunId === 'r009', 'legacy params.runId is surfaced');
  check(ledger.items[1].declaredRunId === 'r010', 'first-class evidence.runId is surfaced');
  check(ledger.items.every((i) => i.status === 'unproven'), 'a declared pointer alone does not prove an interface');
}

// 8) nested interfaces match by owner path ---------------------------------
{
  const child = {
    id: 'head',
    kind: 'assembly',
    children: [{ id: 'cap', kind: 'part', name: 'cap', version: 'v002' }],
    interfaces: [{ id: 'H1', a: 'cap.top', b: 'cap.bottom', severity: 'hard' }],
  };
  const ledger = await buildInterfaceLedger({
    assembly: manifest([], [child]),
    currentVersionSet: ['v001', 'v002'],
    versionTimes: times,
    runs: [run()],
    readReport: async () => report([{ interfaceId: 'H1', ownerPath: ['machine', 'head'], verdict: 'pass' }]),
  });
  check(ledger.items[0].ownerPath.join('/') === 'machine/head', 'owner path is kept', ledger.items[0].ownerPath.join('/'));
  check(ledger.counts.pass === 1, 'nested interface is proven by its owner path');
  check(ledger.parts === 3, 'nested parts are counted too', String(ledger.parts));
}

// 9) citation precedence is one reader ------------------------------------
{
  const pick = (evidence, params) => citedRunId({ evidence, params });
  check(pick({ runId: 'r010' }, { runId: 'r009' }) === 'r010', 'evidence.runId wins over the legacy params.runId');
  check(pick(undefined, { runId: 'r009' }) === 'r009', 'legacy params.runId still resolves');
  check(pick({ runId: '' }, { runId: 'r009' }) === 'r009', 'an empty evidence.runId falls back, never wins empty');
  check(pick(undefined, undefined) === null, 'no pointer is null, never a guess');
}

console.log(failures === 0 ? '\nOK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
