#!/usr/bin/env node
// 04-rack-connector · 语料物化（**评分方脚本；第三方几何不入库**）
//
//   node examples/bench/graders/04-rack-connector/materialize.mjs --out <run-root>
//   [--cache <dir>] [--with-reference]
//
// 为什么是脚本而不是把 STL 提交进仓库（2026-10-12 决策）：
//   * 仓库不复制第三方几何，就不必与第三方的许可证交互（换项目只改钉死的 commit
//     与清单）；本仓的 LICENSE 也就不用为选材背书。
//   * 与既有做法同构：`02-steam-engine` 的 `608.stl` 就是"运行前生成"，01b 的
//     `materialize-01b.mjs` 就是"用脚本物化语料"。
//
// 完整性：**钉死 upstream commit**，并对该 commit 下**全部 `*.scad`** 算一个树摘要
// （`git ls-tree -r` 的 `blobsha path` 排序后取 sha256）+ 逐个编译件再记 sha256。
// 取到的内容只要有一个字节不对，摘要就对不上——脚本直接退出，不进入编译。
//
// 网络实测（2026-10-12，本机）：
//   * `raw.githubusercontent.com` **不可达**（curl exit 35 / node connect_timeout），
//     所以不能按文件 raw 下载；
//   * `codeload.github.com` 的整包 tarball 太慢（120s 只下到 7.9MB，仓库里有大文件）；
//   * 因此用 **git 稀疏取**：只 checkout `*.scad`（100 个文件 740K，秒级完成），
//     `--filter=blob:none` 让其余 blob 根本不下。
//
// 离线：第二次起走 `--cache`（默认在仓库外的 XDG 缓存目录），不再碰网络。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const outDir = resolve(opt('--out', join(REPO, 'examples', 'bench', 'subjects', '04-rack-connector')));
// 缓存默认放在**仓库内**的 `.tmp-*`（`.gitignore` 已覆盖 `/.tmp-*/`），而不是
// `~/.cache`：实测本机 `$HOME` 在沙箱里不可写（`mkdir` 直接 ENOENT），而缓存只是
// 复用取件结果、不该成为运行这道题的前置条件。真实 CI 可用 `--cache` 或
// `XDG_CACHE_HOME` 指到别处。
const cacheDir = resolve(opt('--cache', join(
  process.env.XDG_CACHE_HOME ?? REPO, '.tmp-bench04-cache',
)));
const withReference = argv.includes('--with-reference');

// ---- 钉死的出处 -------------------------------------------------------------
const UPSTREAM = 'https://github.com/jazwa/rackstack';
const COMMIT = '8e296e935aad89a6d1a5023da79becc634c10c2d';
/**
 * `git ls-tree -r` 里全部 `*.scad` 的 `blobsha path` 行、按**路径字节序**排序、
 * 末尾带换行，再取 sha256。等价的命令：
 *   git ls-tree -r HEAD --format='%(objectname) %(path)' | grep '\.scad$' \
 *     | LC_ALL=C sort -k2 | sha256sum
 * **`LC_ALL=C` 不是装饰**：本机默认 locale 下 `sort` 会按 collation 排（忽略 `_`/`-`
 * 等标点），算出来的摘要与字节序不同——第一次就栽在这上面，两个"都对"的摘要差了
 * 一整轮调试。定义写死成字节序，脚本与命令行才不会各说各话。
 */
const TREE_DIGEST = '731039bc9b2480fd2cca8b6b3084826f9a2e86d856297c295acae148030e2381';
const SCAD_FILES = 100;
/** 编译的件：两个给考生（导轨 + 同族接头），一个只留评分方（参考解）。 */
const GIVEN = [
  { name: 'mainRail_P', file: 'rack/print/mainRail_P.scad', out: 'mainRail.stl',
    sha256: '900aa06b6b53a7d2db51399d4913cf6639da229a9ecce34e18c22995ce317f07' },
  { name: 'rackJoiner_P', file: 'rack/print/rackJoiner_P.scad', out: 'rackJoiner.stl',
    sha256: '52ad220116bc30a161d69b6faf724c5b221dec5e87109fd6b45c74a5e43a779d' },
];
const REFERENCE = {
  name: 'stackConnectorBottom_P', file: 'rack/print/stackConnectorBottom_P.scad',
  out: 'reference-stackConnectorBottom.stl',
  sha256: 'f10a9bc4e6ac0eb4d4f3120d2459f45019916d5c7490f936d7457f30c7ac5efc',
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const log = (message) => console.log(`materialize-04: ${message}`);

// ---- 1. 取语料（缓存优先） --------------------------------------------------
const repoDir = join(cacheDir, 'repo');
const treeDigestOf = () => run('git', ['-C', repoDir, 'ls-tree', '-r', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter((line) => line.endsWith('.scad') || /\t.*\.scad$/.test(line))
  .map((line) => {
    const [meta, path] = line.split('\t');
    const blob = meta.split(/\s+/)[2];
    return `${blob} ${path}`;
  })
  .sort((a, b) => (a.split(' ')[1] < b.split(' ')[1] ? -1 : 1))
  .join('\n') + '\n';   // trailing newline: the digest must equal `tree.txt | sha256sum`

const cachedOk = async () => {
  if (!existsSync(join(repoDir, '.git'))) return false;
  try {
    if (run('git', ['-C', repoDir, 'rev-parse', 'HEAD']).trim() !== COMMIT) return false;
    const listing = run('git', ['-C', repoDir, 'ls-tree', '-r', 'HEAD'])
      .split('\n').filter((line) => line.includes('.scad')).length;
    if (listing !== SCAD_FILES) return false;
    return sha256(treeDigestOf()) === TREE_DIGEST;
  } catch {
    return false;
  }
};

if (await cachedOk()) {
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
  const head = run('git', ['-C', repoDir, 'rev-parse', 'HEAD']).trim();
  if (head !== COMMIT) throw new Error(`fetched ${head}, expected ${COMMIT}`);
  const digest = sha256(treeDigestOf());
  if (digest !== TREE_DIGEST) {
    throw new Error(
      `SCAD tree digest ${digest} does not match the pinned ${TREE_DIGEST} — `
      + 'refusing to compile anything from it (the commit moved, or the fetch is corrupt)',
    );
  }
  log(`fetched and verified: ${SCAD_FILES} *.scad, tree digest ok`);
}

// ---- 2. 逐文件 sha256（编译的那几件再核一遍） -------------------------------
for (const item of [...GIVEN, REFERENCE]) {
  const path = join(repoDir, item.file);
  const actual = sha256(await readFile(path));
  if (actual !== item.sha256) {
    throw new Error(`${item.file}: sha256 ${actual} != pinned ${item.sha256}`);
  }
}

// ---- 3. 编译（OpenSCAD；**必须 binstl**，默认是 ASCII 而工具链要二进制） ----
const build = async (item) => {
  const target = join(outDir, item.out);
  const cached = join(cacheDir, 'stl', item.out);
  await mkdir(dirname(cached), { recursive: true });
  if (!existsSync(cached)) {
    run('openscad', ['--export-format', 'binstl', '-o', cached, item.file], { cwd: repoDir, stdio: 'inherit' });
  }
  await mkdir(outDir, { recursive: true });
  await cp(cached, target);
  return { ...item, bytes: (await readFile(target)).length, sha256: sha256(await readFile(target)) };
};

const built = [];
for (const item of GIVEN) built.push(await build(item));
let reference = null;
if (withReference) {
  // 参考解只进缓存（评分方复核用），**不进考生的工作目录**——那是答案。
  const cached = join(cacheDir, 'stl', REFERENCE.out);
  await mkdir(dirname(cached), { recursive: true });
  if (!existsSync(cached)) {
    run('openscad', ['--export-format', 'binstl', '-o', cached, REFERENCE.file], { cwd: repoDir, stdio: 'inherit' });
  }
  reference = { ...REFERENCE, cachePath: cached, sha256: sha256(await readFile(cached)) };
  log(`reference (grader-side only): ${cached}`);
}

// ---- 4. 出处清单 ------------------------------------------------------------
const provenance = {
  note: '第三方几何按 2026-10-12 决策物化：钉 commit、不入库。改上游即改这里的常量。',
  upstream: UPSTREAM,
  commit: COMMIT,
  license: 'MIT (upstream LICENSE; 本仓不复制其内容，只在运行前取)',
  scadFiles: SCAD_FILES,
  treeDigest: TREE_DIGEST,
  built: built.map(({ name, file, out, bytes, sha256: digest }) => ({ name, file, out, bytes, sha256: digest })),
  reference: reference ? { name: reference.name, file: reference.file, sha256: reference.sha256 } : null,
  materializedAt: new Date().toISOString(),
};
await writeFile(join(outDir, 'MATERIALIZED.json'), `${JSON.stringify(provenance, null, 2)}\n`);

for (const item of built) log(`built ${item.out}  ${item.bytes}B  sha256 ${item.sha256.slice(0, 16)}…`);
log(`wrote ${join(outDir, 'MATERIALIZED.json')}`);
if (!withReference) log('（评分方的参考解未编译：加 --with-reference）');
