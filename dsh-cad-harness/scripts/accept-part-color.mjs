// Acceptance: a manifest colour reaches the panel's part identity, and nothing else.
//
// The 64:1 gearbox session lost a whole round to colours: the viewport coloured by
// z-layer while the legend coloured by part name (in_asm red, mid1 green, ...), so
// the human and the agent were naming different parts with the same word. A colour
// declared ONCE in the manifest is the fix — but it must stay a communication
// label: it must not appear where colour never existed, and a manifest without
// colours must look exactly as before.
//
//   node scripts/accept-part-color.mjs

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMachine } from '../src/client/assembly.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const doc = (children) => ({ schemaVersion: 1, name: 'c', unit: 'mm', up: 'z', root: { id: 'r', kind: 'assembly', children } });

// 1. declared colour is read
{
  const m = parseMachine(doc([
    { id: 'a', kind: 'part', name: 'gear_a', version: 'v001', color: '#c0392b' },
    { id: 'b', kind: 'part', name: 'gear_b', version: 'v002' },
  ]));
  check(m?.nodes[0]?.color === '#c0392b', 'a declared colour is read onto the node', JSON.stringify(m?.nodes[0]));
  check(m?.nodes[1]?.color === undefined, 'a part with no colour stays colourless (no invented value)',
    JSON.stringify(m?.nodes[1]));
}

// 2. anything that is not #rrggbb is ignored, not passed through as a CSS colour
for (const bad of ['red', '#12345', '#1234567', 'rgb(1,2,3)', '#GGGGGG', '']) {
  const m = parseMachine(doc([{ id: 'a', kind: 'part', name: 'gear_a', version: 'v001', color: bad }]));
  check(m?.nodes[0]?.color === undefined, `refuses non-hex colour ${JSON.stringify(bad)}`);
}

// 3. the schema documents it as a pattern, so a hand-written manifest is checked too
{
  const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'schemas', 'assembly-manifest.schema.json'), 'utf8'));
  const color = schema.$defs?.node?.properties?.color;
  check(color?.type === 'string', 'the schema declares node.color');
  check(color?.pattern === '^#[0-9a-fA-F]{6}$', 'and constrains it to #rrggbb', String(color?.pattern));
  check(/COMMUNICATION/.test(String(color?.description)) && /does not introduce colour/.test(String(color?.description)),
    'and the description says it is communication-only, not decoration');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
