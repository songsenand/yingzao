// Acceptance for the manifest validator's ERROR OUTPUT (not the geometry).
//
// WHY THIS EXISTS. A real run spent 16 probe runs and ~10 rounds guessing the
// document shape because the only feedback was "root must be an assembly node":
// no path, no expected value, no example, and `{}` produced a TypeError. The
// contract the tool validates has to come back with the rejection.
//
// Each case pins one sentence that must be actionable:
//   1. empty            → both missing keys named, plus the minimal example
//   2. type vs kind     → the hint names `kind` and quotes the legal values
//   3. endpoint ":"     → the hint shows the corrected string
//   4. endpoint owner   → the hint says the prefix must be a DIRECT child
//   5. duplicate id     → the path points at the second node
//   6. valid example    → zero issues (the example in the error is runnable)
//
// Run: node scripts/accept-manifest-errors.mjs

import {
  validateManifest, MANIFEST_EXAMPLE, formatManifestIssues,
} from '../src/host/manifest.ts';

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) fail++;
};

const issues = (m) => validateManifest(m);
const text = (m) => formatManifestIssues(issues(m));

// 1. empty manifest: no TypeError, both keys named, shape help present.
{
  const m = {};
  const t = text(m);
  check('empty: no TypeError', !/Cannot read properties/.test(t));
  check('empty: names schemaVersion and root',
    issues(m).some((p) => p.path === '/schemaVersion') && issues(m).some((p) => p.path === '/root'), t.split('\n')[0]);
}

// 2. the discriminator is `kind`, and the hint says so.
{
  const m = { schemaVersion: 1, root: { id: 'm', type: 'assembly', children: [] } };
  const t = text(m);
  check('type-not-kind: hint names `kind`', /kind/.test(t) && /type/.test(t) && /discriminator/.test(t), t.split('\n').slice(0, 3).join(' | '));
  check('type-not-kind: path is /root/kind', issues(m).some((p) => p.path === '/root/kind'));
}

// 3. endpoint separator: "base:V轴" → shows the corrected "base.V轴".
{
  const m = {
    schemaVersion: 1,
    root: {
      id: 'm', kind: 'assembly',
      children: [{ id: 'base', kind: 'part', version: 'v001' }, { id: 'beam', kind: 'part', version: 'v002' }],
      interfaces: [{ id: 'I1', a: 'base:V轴', b: 'beam.刀口', type: '转动副', severity: 'hard' }],
    },
  };
  const t = text(m);
  check('colon endpoint: shows corrected string', /base\.V轴/.test(t) && /dot/.test(t), t.split('\n').slice(0, 3).join(' | '));
}

// 4. an endpoint naming the owner rather than a direct child.
{
  const m = {
    schemaVersion: 1,
    root: {
      id: 'm', kind: 'assembly',
      children: [{ id: 'base', kind: 'part', version: 'v001' }],
      interfaces: [{ id: 'I1', a: 'm.base', b: 'base.V轴', type: '转动副', severity: 'hard' }],
    },
  };
  check('owner endpoint: hint says DIRECT child', /DIRECT child|relative to the owning node/.test(text(m)), text(m).split('\n')[1] ?? '');
}

// 5. duplicate id points at the second occurrence.
{
  const m = {
    schemaVersion: 1,
    root: {
      id: 'm', kind: 'assembly',
      children: [{ id: 'base', kind: 'part', version: 'v001' }, { id: 'base', kind: 'part', version: 'v002' }],
    },
  };
  check('duplicate id: path is /root/children/1/id', issues(m).some((p) => p.path === '/root/children/1/id'));
}

// 6. the example carried in every error must be valid — otherwise the error
//    teaches a shape the validator then rejects.
{
  check('example: zero issues', issues(MANIFEST_EXAMPLE).length === 0, formatManifestIssues(issues(MANIFEST_EXAMPLE)));
}

// 7. every issue has path + expected + got (so a caller can act without prose).
{
  const m = { schemaVersion: 1, root: { id: 'm', kind: 'assembly', children: [{ kind: 'part' }] } };
  const all = issues(m);
  check('issues are structured', all.length > 0 && all.every((p) => p.path && p.expected && p.got), `${all.length} issue(s)`);
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
