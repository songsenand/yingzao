// The release candidate report: one page a reviewer can read without the repo.
//
// The release notes are prose written by hand; this is the same information derived
// from the repository at the moment of the tag — version, commit, the gate table as
// it stands, the artifact's size/shape, and what is still waiting on a human. It is
// generated, so it cannot drift from the tree the way a hand-written summary can,
// and it is written to `docs/dev/` so the release has a dated record.
//
//   node scripts/release-report.mjs                    # print to stdout
//   node scripts/release-report.mjs --write            # write docs/dev/RELEASE-REPORT-<version>.md
//   node scripts/release-report.mjs --write --notes docs/dev/RELEASE-NOTES-<version>.md
//
// The gate table is READ from the notes, not re-typed: one source, two views.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO = resolve(ROOT, '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const write = args.includes('--write');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const notesPath = resolve(REPO, flag('--notes') ?? `docs/dev/RELEASE-NOTES-${version}.md`);
if (!existsSync(notesPath)) {
  console.error(`no release notes at ${notesPath}`);
  process.exit(2);
}
const notes = readFileSync(notesPath, 'utf8');

const git = (...argv) => {
  try {
    return execFileSync('git', argv, { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const head = git('rev-parse', '--short', 'HEAD');
const headDate = git('show', '-s', '--format=%ci', 'HEAD');
const lastTag = git('describe', '--tags', '--abbrev=0');
const sinceTag = lastTag ? git('log', '--oneline', `${lastTag}..HEAD`).split('\n').filter(Boolean).length : 0;
const dirty = git('status', '--porcelain').split('\n').filter((line) => line && !line.startsWith('??')).length;

// The gate table, as the notes state it (id, status word, evidence cell).
const gates = [...notes.matchAll(/^\| \*\*([A-Z]{1,2}\d+)\*\*([^|]*)\|([^|]*)\|([^|]*)\|/gm)].map((match) => ({
  id: match[1],
  title: match[2].trim(),
  status: match[3].trim(),
  evidence: match[4].trim(),
}));
const closed = gates.filter((gate) => /收口/.test(gate.status));
const waiting = gates.filter((gate) => !/收口/.test(gate.status));

// The artifact, measured now rather than remembered.
const bundle = join(ROOT, 'lib', 'index.js');
const bundleKb = existsSync(bundle) ? Math.round(statSync(bundle).size / 1024) : 0;
const baseline = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'docs', 'TOKEN-BASELINE.json'), 'utf8'));
  } catch {
    return null;
  }
})();

const lines = [];
lines.push(`# 0.2.0-preview.1 发布候选报告（生成）`);
lines.push('');
lines.push('> 本文件由 `node scripts/release-report.mjs --write` 生成，内容取自**当时的仓库**；');
lines.push('> 手改会被下一次生成覆盖。门禁表读自发布说明，不重新打字。');
lines.push('');
lines.push(`- 版本：\`${pkg.name}@${version}\``);
lines.push(`- 提交：\`${head}\`（${headDate}）`);
lines.push(`- 自 \`${lastTag || '(无 tag)'}\` 起：**${sinceTag}** 个提交；未提交的已跟踪改动：**${dirty}** 个`);
lines.push(`- 构建产物：\`lib/index.js\` ${bundleKb} KB`);
if (baseline) {
  lines.push(`- 固定前缀基线（${baseline.recordedAt ?? '?'}）：**${baseline.fixedPrefixChars} chars**`
    + `（9 面 schema ${baseline.surfaceSchemaChars}，预算 ${baseline.surfaceBudgetChars}；`
    + `skill 目录 ${baseline.skillCatalogChars}；对照 45 旧工具 ${baseline.legacySchemaChars}）`);
}
lines.push('');
lines.push(`## 门禁（${closed.length} 收口 / ${waiting.length} 待签收，共 ${gates.length}）`);
lines.push('');
lines.push('| 项 | 状态 | 证据（来自发布说明） |');
lines.push('|---|---|---|');
for (const gate of gates) {
  lines.push(`| ${gate.id} ${gate.title} | ${gate.status} | ${gate.evidence.replace(/\|/g, '/')} |`);
}
lines.push('');
if (waiting.length > 0) {
  lines.push('## 还差什么');
  lines.push('');
  for (const gate of waiting) {
    lines.push(`- **${gate.id}** ${gate.title} — ${gate.status}`);
  }
  lines.push('');
  lines.push('签收步骤见 `docs/dev/CHECKLIST-preview.1-signoff.md`；三项都是"人眼/真机/真会话"，');
  lines.push('机器侧证据已在上面每一行里。');
  lines.push('');
}
lines.push('## 发版命令（需要批准）');
lines.push('');
lines.push('```bash');
lines.push('cd dsh-cad-harness');
lines.push('npm run release:preflight        # 版本同步 / 预设 / 构建 / accept:release / UI / 文档链接');
lines.push(`git tag -s v${version} -m "${version}"`);
lines.push(`git push origin v${version}`);
lines.push('npm stage publish                # 手机 npmjs.com → Staged Packages 批准');
lines.push('```');
lines.push('');

const report = lines.join('\n');
if (!write) {
  process.stdout.write(report);
  process.exit(0);
}
const out = join(REPO, 'docs', 'dev', `RELEASE-REPORT-${version}.md`);
writeFileSync(out, report);
console.log(`wrote ${out.replace(`${REPO}/`, '')} (${closed.length} closed / ${waiting.length} waiting)`);
