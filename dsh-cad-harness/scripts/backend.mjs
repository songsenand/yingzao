#!/usr/bin/env node
// dsh-cad-backend — choose the geometry kernel / OpenSCAD compile backend.
//
// The product-level choice is ONE field: kernel. `compileBackend` is an
// OpenSCAD-adapter detail. 0.1.0-preview ships OpenSCAD only; cadquery/freecad
// are listed as planned and refused, never silently substituted.
//
//   npx dsh-cad-backend --show
//   npx dsh-cad-backend --compile-backend manifold
//   npx dsh-cad-backend --kernel openscad --json
//   npx dsh-cad-backend --list

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const DSH_HOME = process.env.DSH_HOME?.trim() && isAbsolute(process.env.DSH_HOME)
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh');
const FILE = join(DSH_HOME, 'cad', 'backend.json');
const KERNELS = [
  { id: 'openscad', label: 'OpenSCAD', status: 'available', sourceLanguage: 'scad' },
  { id: 'cadquery', label: 'CadQuery', status: 'planned', sourceLanguage: 'py' },
  { id: 'freecad', label: 'FreeCAD', status: 'planned', sourceLanguage: 'py' },
];
const COMPILE = ['auto', 'manifold', 'cgal'];
const DEFAULT = { kernel: 'openscad', compileBackend: 'auto', binaryPath: null };

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`dsh-cad-backend: ${name} needs a value`);
    process.exit(2);
  }
  return value;
}

function read() {
  if (!existsSync(FILE)) return { ...DEFAULT };
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      kernel: typeof raw.kernel === 'string' ? raw.kernel : DEFAULT.kernel,
      compileBackend: COMPILE.includes(raw.compileBackend) ? raw.compileBackend : DEFAULT.compileBackend,
      binaryPath: typeof raw.binaryPath === 'string' ? raw.binaryPath : null,
    };
  } catch (error) {
    console.error(`dsh-cad-backend: cannot read ${FILE}: ${String(error?.message ?? error)}`);
    process.exit(2);
  }
}

const asJson = process.argv.includes('--json');
const list = process.argv.includes('--list');
const show = process.argv.includes('--show') || (!process.argv.includes('--kernel') && !process.argv.includes('--compile-backend') && !list);

if (list) {
  const payload = { file: FILE, kernels: KERNELS, compileBackends: COMPILE };
  console.log(asJson ? JSON.stringify(payload, null, 2) : [
    `kernels: ${KERNELS.map((k) => `${k.id}(${k.status})`).join(', ')}`,
    `compile backends (OpenSCAD adapter): ${COMPILE.join(', ')}`,
  ].join('\n'));
  process.exit(0);
}

const kernel = argValue('--kernel');
const compileBackend = argValue('--compile-backend');
const binaryPath = argValue('--binary');

if (kernel && kernel !== 'openscad') {
  const found = KERNELS.find((k) => k.id === kernel);
  const why = found ? `"${kernel}" is ${found.status} in this build` : `unknown kernel "${kernel}"`;
  console.error(`backend_not_available: ${why}; available: openscad`);
  process.exit(2);
}
if (compileBackend && !COMPILE.includes(compileBackend)) {
  console.error(`dsh-cad-backend: unknown compile backend "${compileBackend}" (use ${COMPILE.join('|')})`);
  process.exit(2);
}

const current = read();
const next = {
  kernel: kernel ?? current.kernel,
  compileBackend: compileBackend ?? current.compileBackend,
  binaryPath: binaryPath ?? current.binaryPath,
};

if (kernel || compileBackend || binaryPath) {
  mkdirSync(join(DSH_HOME, 'cad'), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

const payload = {
  ok: next.kernel === 'openscad',
  file: FILE,
  config: next,
  kernels: KERNELS,
  warnings: next.kernel === 'openscad' ? [] : [`kernel ${next.kernel} is not available`],
};
if (asJson) console.log(JSON.stringify(payload, null, 2));
else if (show || kernel || compileBackend || binaryPath) {
  console.log(`kernel: ${next.kernel}`);
  console.log(`compileBackend: ${next.compileBackend}`);
  console.log(`binaryPath: ${next.binaryPath ?? '(auto)'}`);
  console.log(`file: ${FILE}`);
}
process.exit(payload.ok ? 0 : 2);
