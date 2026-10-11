#!/usr/bin/env node
// 05-rack-assembly · 语料物化（**评分方脚本；第三方几何不入库**）
//
//   node examples/bench/graders/05-rack-assembly/materialize.mjs --out <run-root>
//   [--cache <dir>] [--with-reference]
//
// 与 04 同一套机制（同一钉死的 upstream commit 与全树摘要）：仓库不复制第三方几何，
// 开跑前按 commit 取件、校验、编译。
//
// 这一卷给**两件**已画好的零件（横杆 xBar、立杆 yBar），要求把它们**正确装配**起来；
// 评分方的参考装配由语料自己的装配代码编出来（`attachXBarWithYBar`），只进缓存、
// 不进考生工作目录——那是答案。
//
// 完整性、网络实测坑、`LC_ALL=C` 摘要的由来，全部与 04 的脚本一致，见那边的长注释。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const outDir = resolve(opt('--out', join(REPO, 'examples', 'bench', 'subjects', '05-rack-assembly')));
const cacheDir = resolve(opt('--cache', join(REPO, '.tmp-bench05-cache')));
const withReference = argv.includes('--with-reference');

const UPSTREAM = 'https://github.com/jazwa/rackstack';
const COMMIT = '8e296e935aad89a6d1a5023da79becc634c10c2d';
const TREE_DIGEST = '731039bc9b2480fd2cca8b6b3084826f9a2e86d856297c295acae148030e2381';
const SCAD_FILES = 100;

/** 给考生的两件（都已验证过可独立编译） */
const GIVEN = [
  { name: 'xBar_P', file: 'rack/print/xBar_P.scad', out: 'xBar.stl',
    sha256: 'PLACEHOLDER_XBAR' },
  { name: 'yBarLeft_P', file: 'rack/print/yBarLeft_P.scad', out: 'yBar.stl',
    sha256: 'PLACEHOLDER_YBAR' },
];
/**
 * 评分方的参考装配：用语料**自己的**装配代码编出这两件的正确相对位姿。
 * 注意它不是"两件之并"——语料的装配流程里还带插装的螺母/磁铁模块（实测 13 体），
 * 所以参考件只用来定"装配后的包络与量级"，不用来逐点比对。
 */
const REFERENCE = { name: 'attachXBarWithYBar', out: 'reference-assembly.stl' };

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const log = (message) => console.log(`materialize-05: ${message}`);

const repoDir = join(cacheDir, 'repo');
const treeDigestOf = () => run('git', ['-C', repoDir, 'ls-tree', '-r', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 })
  .split('\n').filter((line) => line.includes('.scad'))
  .map((line) => { const [meta, path] = line.split('\t'); return `${meta.split(/\s+/)[2]} ${path}`; })
  .sort((a, b) => (a.split(' ')[1] < b.split(' ')[1] ? -1 : 1))
  .join('\n') + '\n';

const cachedOk = () => {
  if (!existsSync(join(repoDir, '.git'))) return false;
  try {
    if (run('git', ['-C', repoDir, 'rev-parse', 'HEAD']).trim() !== COMMIT) return false;
    const count = run('git', ['-C', repoDir, 'ls-tree', '-r', 'HEAD']).split('\n').filter((l) => l.includes('.scad')).length;
    return count === SCAD_FILES && sha256(treeDigestOf()) === TREE_DIGEST;
  } catch { return false; }
};

if (cachedOk()) {
  log(`cache hit: ${repoDir} @ ${COMMIT.slice(0, 12)}（树摘要一致，不碰网络）`);
} else {
  log(`fetching ${UPSTREAM} @ ${COMMIT.slice(0, 12)} (sparse: *.scad)`);
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(repoDir, { recursive: true });
  run('git', ['init', '-q', '.'], { cwd: repoDir });
  run('git', ['remote', 'add', 'origin', UPSTREAM], { cwd: repoDir });
  run('git', ['config', 'core.sparseCheckout', 'true'], { cwd: repoDir });
  await writeFile(join(repoDir, '.git', 'info', 'sparse-checkout'), '*.scad\n');
  run('git', ['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', COMMIT], { cwd: repoDir, stdio: 'inherit' });
  run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: repoDir });
  if (run('git', ['-C', repoDir, 'rev-parse', 'HEAD']).trim() !== COMMIT) throw new Error('fetched commit does not match the pin');
  const digest = sha256(treeDigestOf());
  if (digest !== TREE_DIGEST) throw new Error(`SCAD tree digest ${digest} != pinned ${TREE_DIGEST} — refusing to compile`);
  log(`fetched and verified: ${SCAD_FILES} *.scad, tree digest ok`);
}

for (const item of GIVEN) {
  const actual = sha256(await readFile(join(repoDir, item.file)));
  if (!item.sha256.startsWith('PLACEHOLDER') && actual !== item.sha256) {
    throw new Error(`${item.file}: sha256 ${actual} != pinned ${item.sha256}`);
  }
  item.sha256 = actual;   // 首次运行时把实测值带进出处清单
}

const compile = (file, target, cwd = repoDir) => {
  run('openscad', ['--export-format', 'binstl', '-o', target, file], { cwd, stdio: 'inherit' });
  return readFile(target);
};

const built = [];
for (const item of GIVEN) {
  const cached = join(cacheDir, 'stl', item.out);
  await mkdir(dirname(cached), { recursive: true });
  if (!existsSync(cached)) await compile(item.file, cached);
  await mkdir(outDir, { recursive: true });
  await cp(cached, join(outDir, item.out));
  built.push({ ...item, bytes: (await readFile(join(outDir, item.out))).length, sha256: sha256(await readFile(join(outDir, item.out))) });
}

let reference = null;
if (withReference) {
  const cached = join(cacheDir, 'stl', REFERENCE.out);
  await mkdir(dirname(cached), { recursive: true });
  if (!existsSync(cached)) {
    // 用语料自己的装配入口：`attachXBarWithYBar(at=0)` 就是"这两件装在一起"的样子。
    // 驱动文件必须写在 checkout **内部**（`./common.scad` 是相对 include），
    // 否则 openscad 直接 "Can't open input file"（实测踩到）。它是未跟踪文件，
    // 不影响以 `git ls-tree HEAD` 为基准的树摘要。
    const driverPath = join(repoDir, 'rack', 'assembly', '_reference05.scad');
    await writeFile(driverPath,
      'include <./common.scad>\nuse <./attachXBarWithYBar.scad>\nattachXBarWithYBar(at=0);\n');
    run('openscad', ['--export-format', 'binstl', '-o', cached, 'rack/assembly/_reference05.scad'], { cwd: repoDir, stdio: 'inherit' });
  }
  reference = { ...REFERENCE, cachePath: cached, sha256: sha256(await readFile(cached)) };
  log(`reference (grader-side only): ${cached}`);
}

await writeFile(join(outDir, 'MATERIALIZED.json'), `${JSON.stringify({
  note: '第三方几何按 2026-10-12 决策物化：钉 commit、不入库。',
  upstream: UPSTREAM, commit: COMMIT, license: 'MIT (upstream)',
  scadFiles: SCAD_FILES, treeDigest: TREE_DIGEST,
  built: built.map(({ name, file, out, bytes, sha256: digest }) => ({ name, file, out, bytes, sha256: digest })),
  reference: reference ? { name: reference.name, sha256: reference.sha256 } : null,
  materializedAt: new Date().toISOString(),
}, null, 2)}\n`);

for (const item of built) log(`built ${item.out}  ${item.bytes}B  sha256 ${item.sha256.slice(0, 16)}…`);
log(`wrote ${join(outDir, 'MATERIALIZED.json')}`);
if (!withReference) log('（评分方的参考装配未编译：加 --with-reference）');
