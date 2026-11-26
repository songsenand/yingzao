#!/usr/bin/env node
// No user-visible Chinese string literals outside the glossary.
// Comments are ignored; the zh dictionary in i18n.ts is the only allowed home.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'src/client');
// Data vocabulary, not UI: these are values and column names that a report or a
// file carries VERBATIM. The BOM columns are the CSV contract a workshop reads —
// translating them per UI language would produce two different file formats, so
// they stay Chinese everywhere and are allowed here on purpose.
const ALLOW = new Set([
  '角度', '预紧力', '弹簧力', '插入力',
  '零件名', '版本', '数量', '材料', '工艺', '来源', '库存编号',
  '（未确认）',
  // Auto-NAMES of measurements (`距离-1`). A name is data: the user renames it,
  // it travels into a screenshot caption, and it must not change language under a
  // reader who is comparing two revisions.
  '距离', '面积', '孔',
]);
let failed = 0;

for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'i18n.ts')) {
  const file = path.join(dir, name);
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits = [];
  const walk = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (/[\u4e00-\u9fff]/.test(node.text) && !ALLOW.has(node.text)) {
        hits.push(`${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.text.slice(0, 80)}`);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  if (hits.length) {
    failed += hits.length;
    console.error(`  FAIL ${name}`);
    for (const hit of hits) console.error(`    ${hit}`);
  }
}

if (failed === 0) console.log('  PASS client UI literals are English (zh only in i18n.ts)');
else console.error(`  FAIL ${failed} Chinese UI literal(s) outside i18n.ts`);
console.log(`\naccept-ui-i18n: ${failed === 0 ? 1 : 0} passed, ${failed === 0 ? 0 : 1} failed`);
process.exit(failed === 0 ? 0 : 1);
