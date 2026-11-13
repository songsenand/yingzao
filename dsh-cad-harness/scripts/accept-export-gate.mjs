#!/usr/bin/env node
// C1 acceptance: the risk-annotated export is a contract, not a decoration.
//
// Covers the pure pieces (classification, name annotation, manifest, readme,
// audit record). The HTTP 409 + dialog path is exercised by the browser
// acceptance once the panel is built; the server predicate is the same
// classifyExport() tested here.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  annotateDownloadName, auditExport, buildExportManifest, buildUnverifiedReadme, classifyExport,
  newExportId, sha256, writeExportRecord,
} from '../src/host/export-gate.ts';
import { projectStores } from '../src/host/project.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

check('blocked finding -> blocked', classifyExport([{ severity: 'blocked', code: 'x', detail: '' }], 'not-excluded') === 'blocked');
check('excluded audit -> blocked', classifyExport([], 'excluded') === 'blocked');
check('warn finding -> difficult', classifyExport([{ severity: 'warn', code: 'x', detail: '' }], 'not-excluded') === 'difficult');
check('difficult audit -> difficult', classifyExport([], 'difficult') === 'difficult');
check('clean -> pass', classifyExport([], 'not-excluded') === 'pass');

check('suffix before extension', annotateDownloadName('part_v012.stl') === 'part_v012_UNVERIFIED.stl');
check('suffix is idempotent', annotateDownloadName('part_v012_UNVERIFIED.stl') === 'part_v012_UNVERIFIED.stl');
check('extensionless gets suffix', annotateDownloadName('bundle') === 'bundle_UNVERIFIED');

const builtIndex = existsSync(join(ROOT, 'lib', 'index.js')) ? readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8') : '';
const builtClient = existsSync(join(ROOT, 'lib', 'client.js')) ? readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8') : '';
check('server bundle exposes export-blocked', builtIndex.includes('export-blocked'));
check('client bundle wires downloadExport', builtClient.includes('downloadExport'));

const id = newExportId(new Date('2026-11-12T05:00:00Z'));
check('export id is stable-shaped', /^exp-20261112-050000-[0-9a-f]{6}$/.test(id), id);

const bytes = new Uint8Array([1, 2, 3]);
const expected = createHash('sha256').update(bytes).digest('hex');
check('sha256 matches node crypto', sha256(bytes) === expected);

const gate = {
  verdict: 'blocked',
  findings: [{ severity: 'blocked', code: 'printability', detail: 'wall 0.2mm < 0.4mm' }],
  audit: { visual: { required: true } },
  claims: [],
  policy: { source: 'file', mode: 'blocking' },
  notCovered: ['visual-review'],
  nextLook: ['fix it'],
};
const manifest = buildExportManifest({
  exportId: id,
  project: { cwd: '/tmp/project' },
  format: 'stl',
  gate,
  files: [{ path: 'part_v012_UNVERIFIED.stl', bytes }],
  versions: ['v012'],
  override: { reason: 'user says ship', surface: 'web' },
  now: new Date('2026-11-12T05:00:00Z'),
});
check('manifest records the override', manifest.override?.reason === 'user says ship');
check('manifest records the blocked finding', manifest.findings[0]?.code === 'printability');
check('manifest records versions', manifest.versions.includes('v012'));
check('manifest records file hash', manifest.files[0]?.sha256 === expected);
check('manifest records the policy', manifest.policy?.mode === 'blocking');
check('manifest records notCovered', manifest.notCovered.includes('visual-review'));

const readme = buildUnverifiedReadme(manifest);
check('readme says UNVERIFIED', readme.includes('未验证导出') && readme.includes('_UNVERIFIED'));
check('readme carries the finding', readme.includes('printability') && readme.includes('0.2mm'));

const dir = mkdtempSync(join(tmpdir(), 'cad-export-'));
try {
  const record = await writeExportRecord({ cwd: dir }, manifest, readme);
  check('audit record is under exports/<id>', record.endsWith(join('exports', id)));
  check('manifest.json is written', existsSync(join(record, 'manifest.json')));
  check('UNVERIFIED.md is written', existsSync(join(record, 'UNVERIFIED.md')));
  const stored = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  check('stored manifest parses', stored.exportId === id && stored.verdict === 'blocked');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Integration: a real corpus, not only a hand-built finding object.
const corpus = projectStores(join(ROOT, '..', 'examples', 'microscope5'));
const real = await auditExport(corpus);
check('real corpus gate returns a verdict', ['pass', 'difficult', 'blocked'].includes(real.verdict), real.verdict);
check('real corpus is not silently pass (no claims / stale evidence)', real.verdict !== 'pass', real.verdict);
check('real corpus findings are present', real.findings.length > 0);
check('real corpus findings include blocked codes', real.findings.some((f) => f.severity === 'blocked'));

// Policy is part of the gate, not a separate authority.
const policyDir = mkdtempSync(join(tmpdir(), 'cad-policy-'));
try {
  mkdirSync(join(policyDir, 'cad-data'), { recursive: true });
  writeFileSync(join(policyDir, 'cad-data', 'project.json'), JSON.stringify({ schemaVersion: 1 }));
  writeFileSync(join(policyDir, 'claims.json'), JSON.stringify({
    schemaVersion: 1,
    claims: [{ kind: 'strength', statement: 'it holds' }],
  }));
  writeFileSync(join(policyDir, 'evidence-policy.json'), JSON.stringify({
    schemaVersion: 1, mode: 'blocking', blockOn: ['claim-without-witness'],
  }));
  const gated = await auditExport(projectStores(policyDir));
  check('policy blockOn makes the export blocked', gated.verdict === 'blocked', gated.verdict);
  check('gate carries the file policy', gated.policy.source === 'file' && gated.policy.mode === 'blocking', JSON.stringify(gated.policy));
  check('gate carries the policy finding', gated.findings.some((f) => f.severity === 'blocked'));
} finally {
  rmSync(policyDir, { recursive: true, force: true });
}

console.log(`\naccept-export-gate: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
