// Acceptance for project scope: the nearest marker, from the working directory.
//
// B (docs/dev/PROJECT-SCOPE.md): the project is the nearest ancestor with
// `cad-data/project.json` (or legacy `cad-data/`). The agent's current working
// directory is only the starting point; the session header is the fallback when
// the workingDirectory service is absent. There is no delegationDepth special
// case — a subagent's `cwd` is its working directory, and the resolver handles it.
//
// G5 (2026-10-29): the live cwd comes from the workingDirectory SERVICE
// (`ctx.workingDirectory.ensure(agent, signal)`, injected like the stock bash
// tool uses it) — NOT from an `agent.ctx.get(...)` shape that exists on no real
// exec. The previous acceptance stubbed that fictional shape and passed while
// production silently bound the session-header cwd (roberval: corpus landed at
// the repo root). This file now stubs the REAL service interface.
//
//   node scripts/accept-project-cwd.mjs
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectCwdOf, resolveProjectCwd, configureWorkingDirectoryService,
  takeBindingNotice, clearSessionBindingCache,
} from '../src/host/project.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const home = mkdtempSync(join(tmpdir(), 'cad-project-cwd-home-'));
process.env.DSH_HOME = home;
const base = mkdtempSync(join(tmpdir(), 'cad-project-cwd-'));
const real = (path) => {
  try { return realpathSync(path); } catch { return path; }
};
const project = (dir) => {
  mkdirSync(join(dir, 'cad-data'), { recursive: true });
  writeFileSync(join(dir, 'cad-data', 'project.json'), '{}\n');
  return dir;
};
// The REAL interface: a service object with ensure(agent, signal), injected at
// plugin activation. `live === undefined` models a deployment without the service.
const execOf = (header) => ({ agent: { session: { header } } });
const useLiveCwd = (live) => {
  configureWorkingDirectoryService(live === undefined ? undefined : { ensure: async () => live });
};

try {
  const parent = project(join(base, 'parent'));
  mkdirSync(join(parent, 'spec'), { recursive: true });
  const child = project(join(base, 'child'));

  useLiveCwd(join(parent, 'spec'));
  check(await projectCwdOf(execOf({ cwd: parent })) === real(parent),
    'a cd into a subdirectory stays on the nearest marker',
    await projectCwdOf(execOf({ cwd: parent })));
  useLiveCwd(child);
  check(await projectCwdOf(execOf({ cwd: parent, delegationDepth: 1 })) === real(child),
    'a delegated session follows its working directory (no delegationDepth special case)',
    await projectCwdOf(execOf({ cwd: parent, delegationDepth: 1 })));
  useLiveCwd(undefined);
  check(await projectCwdOf(execOf({ cwd: parent })) === real(parent),
    'no workingDirectory service falls back to the header',
    await projectCwdOf(execOf({ cwd: parent })));
  useLiveCwd('');
  check(await projectCwdOf(execOf({ cwd: parent })) === real(parent),
    'an empty projection falls back to the header',
    await projectCwdOf(execOf({ cwd: parent })));

  const fresh = join(base, 'fresh');
  mkdirSync(fresh);
  useLiveCwd(fresh);
  check(await projectCwdOf(execOf({ cwd: parent })) === real(fresh),
    'a directory with no marker is a new project candidate',
    await projectCwdOf(execOf({ cwd: parent })));

  useLiveCwd(undefined);
  // "no agent" resolves from the SERVER cwd upward — the assertion needs a cwd with
  // no cad-data marker at or above it, so run it inside a clean tmp subdir (a real
  // corpus at/above the repo root would otherwise be found, and rightly so).
  const clean = join(base, 'clean');
  mkdirSync(clean);
  const origCwd = process.cwd();
  process.chdir(clean);
  check(await projectCwdOf(execOf({})) === real(clean), 'no agent falls back to the server cwd', await projectCwdOf(execOf({})));
  process.chdir(origCwd);
  useLiveCwd(fresh);
  check(await projectCwdOf(execOf({})) === real(fresh),
    'no header cwd uses the working directory',
    await projectCwdOf(execOf({})));

  // --- the roberval case: header cwd is STALE, the live cwd is what counts ----
  const example = project(join(base, 'example'));
  useLiveCwd(example);
  {
    const r = await resolveProjectCwd(execOf({ id: 'g5', cwd: base }));
    check(r.cwd === real(example) && r.newlyBound,
      'G5: a session whose header cwd is stale binds its LIVE working directory',
      `${r.cwd} newlyBound=${r.newlyBound}`);
    check(existsSync(join(home, 'cad', 'sessions', 'g5.json')), 'the binding is persisted');
    const notice = takeBindingNotice(execOf({ id: 'g5' }));
    check(typeof notice === 'string' && notice.includes(real(example)),
      'the first bind says so in the reply (the wrong-bind used to be silent)', notice ?? '(none)');
    check(takeBindingNotice(execOf({ id: 'g5' })) === undefined,
      'the notice is consumed once');
    const r2 = await resolveProjectCwd(execOf({ id: 'g5', cwd: base }));
    check(r2.cwd === real(example) && !r2.newlyBound, 'the second call is bound, not new');
  }
  clearSessionBindingCache();

  // --- C-lite: the first CAD call binds the session; later cd does not switch.
  useLiveCwd(join(parent, 'spec'));
  check(await projectCwdOf(execOf({ id: 's1', cwd: parent })) === real(parent),
    'the first CAD call binds the session to the nearest marker',
    await projectCwdOf(execOf({ id: 's1', cwd: parent })));
  check(existsSync(join(home, 'cad', 'sessions', 's1.json')), 'the binding is persisted');
  useLiveCwd(child);
  check(await projectCwdOf(execOf({ id: 's1', cwd: parent })) === real(parent),
    'a later cd to a sibling does not switch a bound session',
    await projectCwdOf(execOf({ id: 's1', cwd: parent })));
  clearSessionBindingCache();
  check(await projectCwdOf(execOf({ id: 's1', cwd: parent })) === real(parent),
    'the binding survives an in-process cache clear',
    await projectCwdOf(execOf({ id: 's1', cwd: parent })));
  check(await projectCwdOf(execOf({ id: 's2', cwd: parent })) === real(child),
    'a new session binds its own working directory',
    await projectCwdOf(execOf({ id: 's2', cwd: parent })));
  check(await projectCwdOf(execOf({ id: 's3', cwd: parent, delegationDepth: 1 })) === real(child),
    'a delegated session binds its own cwd',
    await projectCwdOf(execOf({ id: 's3', cwd: parent, delegationDepth: 1 })));
  useLiveCwd(parent);
  check(await projectCwdOf(execOf({ id: 's3', cwd: parent, delegationDepth: 1 })) === real(child),
    'a bound delegated session stays put',
    await projectCwdOf(execOf({ id: 's3', cwd: parent, delegationDepth: 1 })));

  rmSync(parent, { recursive: true, force: true });
  useLiveCwd(child);
  check(await projectCwdOf(execOf({ id: 's1', cwd: parent })) === real(child),
    'a deleted bound root falls back to the resolver and rebinds',
    await projectCwdOf(execOf({ id: 's1', cwd: parent })));
} finally {
  configureWorkingDirectoryService(undefined);
  rmSync(base, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
