// CadQuery pack discovery. The pack is a `pip --target` directory, NOT a
// mutation of the bundled runtime venv: no dependency conflict, no surprise
// upgrade of numpy/scipy, and removing the directory reverts the capability.
//
// Location: `$DSH_HOME/cad/packs/cadquery` by default, overridable with
// `DSH_CAD_CQ_PACK`. Nothing here downloads; installation is explicit.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { dshHomeDir } from './backend.ts';

export const CADQUERY_PACK_ENV = 'DSH_CAD_CQ_PACK';

export interface CadQueryPackStatus {
  root: string;
  installed: boolean;
  version: string | null;
  issues: string[];
}

/** Pack root; env override wins so tests can point at a scratch target. */
export function cadqueryPackRoot(): string {
  const override = process.env[CADQUERY_PACK_ENV]?.trim();
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(dshHomeDir(), 'cad', 'packs', 'cadquery');
}

/** `PYTHONPATH` that makes the pack win without touching the venv. */
export function cadqueryPythonEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const root = cadqueryPackRoot();
  const existing = base.PYTHONPATH?.trim();
  return { ...base, PYTHONPATH: existing ? `${root}${delimiter}${existing}` : root };
}

export function cadqueryInstallHint(): string {
  const root = cadqueryPackRoot();
  const python = process.platform === 'win32' ? 'python' : 'python3';
  return (
    `install the pack explicitly with the bundled runtime: ` +
    `${python} -m pip install --target "${root}" ` +
    `cadquery==2.8.0 cadquery-ocp==7.9.3.1.1 vtk==9.6.2 casadi==3.8.2 ` +
    `scipy==1.18.1 numpy==2.5.5 ezdxf==1.4.5 multimethod==1.12 nlopt==2.11.0 ` +
    `runtype==0.5.3 pyparsing==3.3.3 typing_extensions==4.16.0`
  );
}

/** Never throws: a missing/broken pack is a capability state, not a crash. */
export async function cadqueryPackStatus(): Promise<CadQueryPackStatus> {
  const root = cadqueryPackRoot();
  const issues: string[] = [];
  const hasCadquery = existsSync(join(root, 'cadquery', '__init__.py'));
  const hasOcp = existsSync(join(root, 'OCP')) || existsSync(join(root, 'cadquery_ocp'));
  if (!hasCadquery) issues.push(`cadquery not found under ${root}`);
  if (!hasOcp) issues.push(`OCP not found under ${root}`);
  let version: string | null = null;
  if (hasCadquery) {
    try {
      const names = await readdir(root);
      const dist = names.find((name) => /^cadquery-[\d.]+\.dist-info$/.test(name));
      if (dist) {
        const metadata = await readFile(join(root, dist, 'METADATA'), 'utf8');
        version = /^Version:\s*(.+)$/m.exec(metadata)?.[1]?.trim() ?? dist.replace(/^cadquery-/, '').replace(/\.dist-info$/, '');
      }
    } catch { /* version is informative; absence is not a pack failure */ }
  }
  return { root, installed: hasCadquery && hasOcp, version, issues };
}
