#!/usr/bin/env node
// No user-visible Chinese string literals outside the glossary.
// Comments are ignored; the zh dictionary in i18n.ts is the only allowed home.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'src/client');
const ALLOW = new Set(['角度', '预紧力', '弹簧力', '插入力']); // report data vocabulary, not UI
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
