// Acceptance for project scope: the nearest marker, from the working directory.
//
// B (docs/dev/PROJECT-SCOPE.md): the project is the nearest ancestor with
// `cad-data/project.json` (or legacy `cad-data/`). The agent's current working
// directory is only the starting point; the session header is the fallback when
// the workingDirectory service is absent. There is no delegationDepth special
// case — a subagent's `cwd` is its working directory, and the resolver handles it.
//
//   node scripts/accept-project-cwd.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectCwdOf } from '../src/host/project.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const base = mkdtempSync(join(tmpdir(), 'cad-project-cwd-'));
const real = (path) => {
  try { return realpathSync(path); } catch { return path; }
};
const project = (dir) => {
  mkdirSync(join(dir, 'cad-data'), { recursive: true });
  writeFileSync(join(dir, 'cad-data', 'project.json'), '{}\n');
  return dir;
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

try {
  const parent = project(join(base, 'parent'));
  mkdirSync(join(parent, 'spec'), { recursive: true });
  const child = project(join(base, 'child'));

  check(projectCwdOf(exec({ cwd: parent }, join(parent, 'spec'))) === real(parent),
    'a cd into a subdirectory stays on the nearest marker',
    projectCwdOf(exec({ cwd: parent }, join(parent, 'spec'))));
  check(projectCwdOf(exec({ cwd: parent, delegationDepth: 1 }, child)) === real(child),
    'a delegated session follows its working directory (no delegationDepth special case)',
    projectCwdOf(exec({ cwd: parent, delegationDepth: 1 }, child)));
  check(projectCwdOf(exec({ cwd: parent }, child, false)) === real(parent),
    'no workingDirectory service falls back to the header',
    projectCwdOf(exec({ cwd: parent }, child, false)));
  check(projectCwdOf(exec({ cwd: parent }, '')) === real(parent),
    'an empty projection falls back to the header',
    projectCwdOf(exec({ cwd: parent }, '')));

  const fresh = join(base, 'fresh');
  mkdirSync(fresh);
  check(projectCwdOf(exec({ cwd: parent }, fresh)) === real(fresh),
    'a directory with no marker is a new project candidate',
    projectCwdOf(exec({ cwd: parent }, fresh)));

  check(projectCwdOf({}) === process.cwd(), 'no agent falls back to the server cwd');
  check(projectCwdOf(exec({}, fresh)) === real(fresh),
    'no header cwd uses the working directory',
    projectCwdOf(exec({}, fresh)));
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
