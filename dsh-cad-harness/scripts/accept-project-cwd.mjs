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
  takeBindingNotice, clearSessionBindingCache, resolveProjectRoot,
  createProjectMarker, projectInfoFor, bindSessionToProject,
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

  // --- C-lite: an explicit first call binds; later cd does not switch.
  // `projectCwdOf` is a READ and must NOT bind (no side-effect selection).
  useLiveCwd(join(parent, 'spec'));
  check(await projectCwdOf(execOf({ id: 'read-only', cwd: parent })) === real(parent),
    'the read path resolves the nearest marker without selecting it',
    await projectCwdOf(execOf({ id: 'read-only', cwd: parent })));
  check(!existsSync(join(home, 'cad', 'sessions', 'read-only.json')),
    'projectCwdOf writes NO session binding');
  const first = await resolveProjectCwd(execOf({ id: 's1', cwd: parent }));
  check(first.cwd === real(parent) && first.newlyBound,
    'the first explicit call binds the session to the nearest marker', `${first.cwd}`);
  check(existsSync(join(home, 'cad', 'sessions', 's1.json')), 'the binding is persisted');
  useLiveCwd(child);
  check(await projectCwdOf(execOf({ id: 's1', cwd: parent })) === real(parent),
    'a later cd to a sibling does not switch a bound session',
    await projectCwdOf(execOf({ id: 's1', cwd: parent })));
  clearSessionBindingCache();
  check(await projectCwdOf(execOf({ id: 's1', cwd: parent })) === real(parent),
    'the binding survives an in-process cache clear',
    await projectCwdOf(execOf({ id: 's1', cwd: parent })));
  check((await resolveProjectCwd(execOf({ id: 's2', cwd: parent }))).cwd === real(child),
    'a new session binds its own working directory');
  check((await resolveProjectCwd(execOf({ id: 's3', cwd: parent, delegationDepth: 1 }))).cwd === real(child),
    'a delegated session binds its own cwd');
  useLiveCwd(parent);
  check(await projectCwdOf(execOf({ id: 's3', cwd: parent, delegationDepth: 1 })) === real(child),
    'a bound delegated session stays put',
    await projectCwdOf(execOf({ id: 's3', cwd: parent, delegationDepth: 1 })));

  // --- fail-closed write target: a subdirectory of an ancestor is NOT a target -
  {
    const ambiguous = join(parent, 'ambiguous');
    mkdirSync(ambiguous, { recursive: true });
    useLiveCwd(ambiguous);
    let refused = '';
    try {
      await resolveProjectCwd(execOf({ id: 'strict-refused', cwd: parent }), { requireExplicit: true });
    } catch (e) { refused = String(e); }
    check(/write target is ambiguous/.test(refused) && /init_project/.test(refused) && /bind_project/.test(refused),
      'an unbound session in a subdirectory of an ancestor project is REFUSED (not silently bound)',
      refused.slice(0, 120));
    check(!existsSync(join(home, 'cad', 'sessions', 'strict-refused.json')),
      'the refused call wrote NO binding');
    const ambInfo = await projectInfoFor(execOf({ id: 'strict-refused', cwd: parent }));
    check(ambInfo.selected === false && ambInfo.ambiguous === true && /NO CAD project is selected/.test(ambInfo.note),
      'project_info says no project is selected and names the ambiguous cwd', JSON.stringify(ambInfo));

    let noSelection = '';
    try {
      await resolveProjectCwd(execOf({ id: 'strict-refused', cwd: parent }), { requireSelection: true });
    } catch (e) { noSelection = String(e); }
    check(/No CAD project is selected/.test(noSelection),
      'the write path refuses when no project has been selected', noSelection.slice(0, 120));

    // The sanctioned fix: make this directory a project, then the same session
    // can bind it on the next call.
    await createProjectMarker(ambiguous, 'ambiguous example');
    const afterInit = await resolveProjectCwd(execOf({ id: 'strict-init', cwd: parent }), { requireExplicit: true });
    check(afterInit.cwd === real(ambiguous) && afterInit.newlyBound,
      'init_project + retry binds the new marker (no move/copy)', `${afterInit.cwd}`);

    // Or explicitly choose the ancestor from a subdirectory.
    useLiveCwd(join(parent, 'spec'));
    const bound = await bindSessionToProject(execOf({ id: 'strict-bind', cwd: parent }), parent);
    check(bound.root === real(parent),
      'bind_project explicitly chooses an existing ancestor', JSON.stringify(bound));
    const afterBind = await resolveProjectCwd(execOf({ id: 'strict-bind', cwd: parent }), { requireExplicit: true });
    check(afterBind.cwd === real(parent) && !afterBind.newlyBound,
      'the explicit binding is what the write path uses', afterBind.cwd);
    let rebind = '';
    try { await bindSessionToProject(execOf({ id: 'strict-bind', cwd: parent }), ambiguous); }
    catch (e) { rebind = String(e); }
    check(/already bound/.test(rebind),
      'bind_project refuses to rebind an already-bound session (no move after writes)',
      rebind.slice(0, 120));
  }

  // --- a workspace is a container, never a write target ----------------------
  {
    const ws = join(base, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'cad-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'workspace', title: 'ws' }));
    check(resolveProjectRoot(ws).root === real(ws) && resolveProjectRoot(ws).marker === 'workspace',
      'cad-workspace.json makes the root a workspace, not a project');
    useLiveCwd(ws);
    let refused = '';
    try { await resolveProjectCwd(execOf({ id: 'ws-refused', cwd: ws }), { requireExplicit: true }); }
    catch (e) { refused = String(e); }
    check(/WORKSPACE, not a project/.test(refused), 'a write at the workspace root is REFUSED', refused.slice(0, 120));
    let rootInit = '';
    try { await createProjectMarker(ws); } catch (e) { rootInit = String(e); }
    check(/workspace, not a project/.test(rootInit), 'init_project refuses to turn the workspace root into a project');
    const member = await createProjectMarker(join(ws, 'member'), 'member');
    check(member.created === true, 'init_project works in a workspace member directory', JSON.stringify(member));
    let bindWs = '';
    try { await bindSessionToProject(execOf({ id: 'ws-bind', cwd: ws }), ws); } catch (e) { bindWs = String(e); }
    check(/workspace, not a project/.test(bindWs), 'bind_project refuses a workspace root');
  }

  // --- C-lite lifecycle: create a marker WITHOUT rebinding; see the binding ----
  {
    const nested = join(parent, 'nested-example');
    mkdirSync(nested, { recursive: true });
    const made = await createProjectMarker(nested, 'nested example');
    check(made.created && existsSync(join(nested, 'cad-data', 'project.json')),
      'init_project creates only cad-data/project.json', JSON.stringify(made));
    check(made.inheritedFrom === real(parent),
      'it names the ancestor project the new marker shadows', String(made.inheritedFrom));
    check(resolveProjectRoot(nested).root === real(nested) && resolveProjectRoot(nested).marker === 'project',
      'the new marker becomes the nearest project for a new session');
    const madeAgain = await createProjectMarker(nested);
    check(madeAgain.created === false && madeAgain.key === made.key,
      're-running is idempotent (created:false, same key)');

    // A session already bound to parent must NOT switch when the live cwd moves
    // into the new nested marker; project_info must say so.
    useLiveCwd(join(parent, 'spec'));
    await bindSessionToProject(execOf({ id: 'bound-parent', cwd: parent }), parent);
    useLiveCwd(nested);
    const info = await projectInfoFor(execOf({ id: 'bound-parent', cwd: parent }));
    check(info.boundRoot === real(parent) && info.mismatch === true,
      'project_info reports boundRoot + mismatch when live cwd is a different project',
      JSON.stringify(info));
    const freshInfo = await projectInfoFor(execOf({ id: 'fresh-nested', cwd: nested }));
    check(freshInfo.boundRoot === null && freshInfo.selected === false && freshInfo.wouldBindTo === null,
      'an unbound session has NO default project', JSON.stringify(freshInfo));
  }

  rmSync(parent, { recursive: true, force: true });
  useLiveCwd(child);
  check(await projectCwdOf(execOf({ id: 's1', cwd: parent })) === real(child),
    'a deleted bound root falls back to the read resolver (no side-effect binding)',
    await projectCwdOf(execOf({ id: 's1', cwd: parent })));
} finally {
  configureWorkingDirectoryService(undefined);
  rmSync(base, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
