// CAD filesystem policy: the assembly contract has ONE writer.
//
// `write_assembly` (and the dsh-cad-contract CLI) are the only paths that append
// a change record and materialize `assembly/assembly.json` + `assembly.seal`.
// Generic `write`/`edit`/`apply_patch`/`delete` must not touch those files:
// they would produce bytes without a seal record, which every reader refuses.
//
// This listener is registered for the `fs/*` intent events the tool-fs tools
// dispatch. It throws a typed refusal for the protected paths and returns
// `undefined` otherwise, leaving the decision to the provider/other policies.
// It is a process barrier, not an OS sandbox: a direct `bash` write can still
// change bytes, but the seal check makes that edit ineffective.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { liveCwdOf } from './project.ts';

const PROTECTED = [
  /(^|\/)assembly\/assembly\.json$/,
  /(^|\/)assembly\/assembly\.seal$/,
  /(^|\/)assembly\/changes(\/|$)/,
];

/** True when a path names one of the contract's writer-owned files. */
export function isProtectedAssemblyPath(displayPath: string): boolean {
  const normalized = String(displayPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return PROTECTED.some((pattern) => pattern.test(normalized));
}

/** A CAD project has `cad-data/project.json` (or the legacy bare `cad-data/`) at or above the file. */
export function isCadProjectPath(displayPath: string, baseCwd: string = process.cwd()): boolean {
  let dir = dirname(resolve(baseCwd, String(displayPath)));
  for (let depth = 0; depth < 40; depth += 1) {
    if (existsSync(join(dir, 'cad-data', 'project.json')) || existsSync(join(dir, 'cad-data'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

function refuse(displayPath: string): never {
  const error = new Error(
    `refusing to write the assembly contract through a generic filesystem tool: ${displayPath}. ` +
    'The contract is sealed; use cad_assembly({ action: "write", args: { reason, expectedRevision, ... } }) ' +
    'or `dsh-cad-contract write`. A direct edit has no change record and is rejected by the seal check.',
  );
  (error as unknown as { name: string }).name = 'FsError';
  (error as unknown as { code: string }).code = 'FS_PERMISSION_DENIED';
  throw error;
}

async function guard(
  target: { displayPath?: unknown } | undefined,
  exec: unknown,
): Promise<undefined> {
  const displayPath = typeof target?.displayPath === 'string' ? target.displayPath : '';
  if (!displayPath || !isProtectedAssemblyPath(displayPath)) return undefined;
  const cwd = await liveCwdOf(exec).catch(() => null);
  if (!isCadProjectPath(displayPath, cwd ?? process.cwd())) return undefined;
  refuse(displayPath);
}

/**
 * Register the intent listeners. `ctx.on` is the Cordis event API; the
 * listeners are intentionally stateless so HMR/disposal needs no teardown.
 */
export function applyCadFsPolicy(ctx: any): void {
  if (typeof ctx?.on !== 'function') return;
  ctx.on('fs/write-intent', (target: unknown, exec: unknown) => guard(target as { displayPath?: unknown }, exec));
  ctx.on('fs/edit-intent', (target: unknown, exec: unknown) => guard(target as { displayPath?: unknown }, exec));
  ctx.on('fs/delete-intent', (target: unknown, exec: unknown) => guard(target as { displayPath?: unknown }, exec));
}
