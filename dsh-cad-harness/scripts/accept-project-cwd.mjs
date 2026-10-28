// Acceptance for project scope of a delegated session.
//
// The bug this pins: DSH keeps a subagent's `session.header.cwd` at the
// parent's workspace and puts the requested `cwd` only in the
// `workingDirectory` projection. `projectCwdOf` used to read the header, so a
// subagent working in `examples/ball-and-stick/fructose-molecule` still wrote
// `cad-data/` under the repo root. The delegated branch now follows the
// projection; top-level sessions keep the durable creation cwd (a `cd` into a
// subdirectory must not relocate the corpus).
//
//   node scripts/accept-project-cwd.mjs
import { projectCwdOf } from '../src/host/project.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const exec = (header, workingDirectory, hasService = true) => ({
  agent: {
    session: { header },
    ctx: {
      get: (name) => (name === 'workingDirectory' && hasService
        ? { get: () => workingDirectory }
        : undefined),
    },
  },
});

check(projectCwdOf(exec({ cwd: '/parent', delegationDepth: 1 }, '/child')) === '/child',
  'a delegated session follows its working directory', projectCwdOf(exec({ cwd: '/parent', delegationDepth: 1 }, '/child')));
check(projectCwdOf(exec({ cwd: '/parent' }, '/child')) === '/parent',
  'a top-level session keeps its durable creation cwd (a cd must not move the corpus)',
  projectCwdOf(exec({ cwd: '/parent' }, '/child')));
check(projectCwdOf(exec({ cwd: '/parent', delegationDepth: 1 }, '/child', false)) === '/parent',
  'no workingDirectory service falls back to the header', projectCwdOf(exec({ cwd: '/parent', delegationDepth: 1 }, '/child', false)));
check(projectCwdOf(exec({ cwd: '/parent', delegationDepth: 1 }, '')) === '/parent',
  'an empty projection falls back to the header', projectCwdOf(exec({ cwd: '/parent', delegationDepth: 1 }, '')));
check(projectCwdOf(exec({}, '/child')) === process.cwd(),
  'no header cwd falls back to the server cwd', projectCwdOf(exec({}, '/child')));
check(projectCwdOf({}) === process.cwd(),
  'no agent falls back to the server cwd', projectCwdOf({}));

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
