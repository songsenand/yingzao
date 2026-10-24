// Acceptance for the machine object (T2.5).
//
// The assembly manifest is the project's own statement of what the machine is;
// the navigator shows it as ONE object instead of scattering its runs across four
// run categories. This checks the reduction, not the pixels:
//   node  scripts/accept-machine.mjs
const { parseMachine } = await import('../src/client/assembly.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// The toy-balance shape: nested assemblies, duplicate part instances, transforms.
const doc = {
  name: 'toy-pan-balance 玩具托盘天平',
  root: {
    id: 'machine',
    kind: 'assembly',
    children: [
      { id: 'base', kind: 'part', part: '底座立柱', version: 'v001' },
      {
        id: 'beamGroup',
        kind: 'assembly',
        children: [
          { id: 'beam', kind: 'part', part: '横梁', version: 'v003', transform: { translate: [0, 0, 101] } },
          { id: 'stirrupL', kind: 'part', part: '吊架', version: 'v029' },
          { id: 'stirrupR', kind: 'part', part: '吊架', version: 'v029' },
        ],
      },
      { id: 'emptyGroup', kind: 'assembly', children: [] },
    ],
  },
};

const m = parseMachine(doc);
check(m !== null, 'a manifest with part nodes produces a machine');
check(m?.name === 'toy-pan-balance 玩具托盘天平', 'the machine keeps the manifest name', m?.name);
check(m?.nodes.length === 4, 'nested assemblies contribute their nodes (4)', String(m?.nodes.length));
check(m?.distinctParts === 3, 'duplicate instances count once in distinctParts (3)', String(m?.distinctParts));
check(m?.nodes.filter((n) => n.part === '吊架').length === 2, 'two hanger INSTANCES stay two nodes');
check(m?.nodes[0]?.version === 'v001', 'a node keeps its pinned version', String(m?.nodes[0]?.version));

check(parseMachine({ root: { kind: 'assembly', children: [] } }) === null, 'an empty assembly is NOT a machine');
check(parseMachine({}) === null, 'a payload without a root is null');
check(parseMachine(null) === null, 'null is null');
check(
  parseMachine({ root: { kind: 'assembly', children: [{ id: 'x', kind: 'part', part: '  ' }] } }) === null,
  'a node with a blank part name does not invent a part',
);
// microscope5's shape: the part is named `name`, not `part`. Reading only `part`
// made a valid manifest look like "no machine" in the panel.
const named = parseMachine({
  name: '显微镜',
  root: { kind: 'assembly', children: [{ id: 'base', kind: 'part', name: '底座', version: 'v001' }] },
});
check(named?.nodes[0]?.part === '底座', 'a node that names its part in `name` is understood', named?.nodes[0]?.part);
check(named?.name === '显微镜', 'the machine name still comes from the document', named?.name);
const both = parseMachine({ root: { kind: 'part', id: 'x', part: '甲', name: '乙' } });
check(both?.nodes[0]?.part === '甲', 'when both fields exist, `part` wins (the older, more specific field)');

const fallback = parseMachine({ root: { id: 'machine', children: [{ kind: 'part', part: '甲' }] } });
check(fallback?.name === 'machine', 'no name anywhere falls back to the root id', fallback?.name);
check(fallback?.nodes[0]?.version === null, 'a node without a version says null, not empty string');

console.log(failures ? `\nFAILED (${failures})` : '\nOK');
process.exit(failures ? 1 : 0);
