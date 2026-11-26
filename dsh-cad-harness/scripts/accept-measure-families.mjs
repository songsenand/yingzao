// U15 acceptance — the measurement families the viewport can now answer.
//
// A measurement is a NUMBER a person will quote, so the failures that matter are
// arithmetic: an angle at the wrong vertex, a click that lands in a hole but
// reports the outer face, a bore diameter computed from the wrong area, a deleted
// measurement that leaves a duplicate name. All of that is checkable here.
//
//   node scripts/accept-measure-families.mjs

import {
  addMeasurement, angleDeg, autoName, describeLoops, distanceMm, equivalentDiameterMm,
  loopAt, loopPerimeter, measurementSummary, removeMeasurement, renameMeasurement,
} from '../src/client/measure-families.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('measure families acceptance\n');

// ── distance ────────────────────────────────────────────────────────────────
check(near(distanceMm([0, 0, 0], [3, 4, 0]), 5), 'distance is euclidean', String(distanceMm([0, 0, 0], [3, 4, 0])));
check(near(distanceMm([1, 2, 3], [1, 2, 3]), 0), 'a point to itself is 0');

// ── angle ───────────────────────────────────────────────────────────────────
check(near(angleDeg([1, 0, 0], [0, 0, 0], [0, 1, 0]), 90), 'a right angle is 90°');
check(near(angleDeg([1, 0, 0], [0, 0, 0], [-1, 0, 0]), 180), 'a straight line is 180°');
check(near(angleDeg([1, 0, 0], [0, 0, 0], [1, 0, 0]), 0), 'the same ray twice is 0°');
check(near(angleDeg([2, 0, 0], [1, 0, 0], [1, 1, 0]), 90), 'the angle is AT the middle point, not at the origin');
check(near(angleDeg([1, 1, 0], [0, 0, 0], [1, 0, 0]), 45), 'a 45° pair reads 45°');
check(angleDeg([0, 0, 0], [0, 0, 0], [1, 0, 0]) === null, 'a degenerate ray gives null, not NaN');
check(angleDeg([1, 0, 0], [1, 0, 0], [1, 0, 0]) === null, 'two zero-length rays give null');

// ── section loops: area, perimeter, hole classification ────────────────────
const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
const outer = square(0, 0, 20);      // 400mm²
const hole = square(8, 8, 4);        // 16mm², inside `outer`
const island = square(9, 9, 2);      // 4mm², inside `hole` → depth 2, material again

check(near(loopPerimeter(outer), 80), 'perimeter of a 20mm square is 80mm', String(loopPerimeter(outer)));

const described = describeLoops([outer, hole, island]);
check(described.length === 3, 'every loop is described');
check(near(described[0].areaMm2, 400) && !described[0].isHole && described[0].depth === 0,
  'the outer face is material at depth 0', `${described[0].areaMm2} depth=${described[0].depth}`);
check(near(described[1].areaMm2, 16) && described[1].isHole && described[1].depth === 1,
  'the nested square is a HOLE at depth 1', `${described[1].areaMm2} depth=${described[1].depth}`);
check(near(described[2].areaMm2, 4) && !described[2].isHole && described[2].depth === 2,
  'an island inside a hole is material again (depth 2)');

// A click inside the hole — and OUTSIDE the island that sits in it — reports the
// HOLE, not the outer face. (10,10) would be the island: the smallest loop wins.)
const inHole = loopAt([outer, hole, island], [8.5, 8.5]);
check(inHole?.index === 1 && inHole.isHole, 'a click inside the bore reports the bore', JSON.stringify(inHole));
// A click inside the island reports the island (smallest containing loop).
const inIsland = loopAt([outer, hole, island], [9.5, 9.5]);
check(inIsland?.index === 2, 'a click on an island reports the island, not the outer face', JSON.stringify(inIsland));
// A click outside everything reports nothing (an empty section is not a zero).
check(loopAt([outer, hole], [50, 50]) === null, 'a click outside every loop measures nothing');
check(loopAt([], [0, 0]) === null, 'no loops measure nothing');

// ── hole diameter ──────────────────────────────────────────────────────────
const circleArea = Math.PI * 36; // r = 6
check(near(equivalentDiameterMm(circleArea), 12, 1e-9), 'a Ø12 bore measures Ø12', String(equivalentDiameterMm(circleArea)));
check(equivalentDiameterMm(0) === 0, 'zero area is Ø0, not NaN');
check(near(equivalentDiameterMm(16), 2 * Math.sqrt(16 / Math.PI), 1e-12), 'a square bore reports the EQUIVALENT diameter');

// ── history: add / rename / delete ─────────────────────────────────────────
let list = addMeasurement([], { kind: 'distance', value: 12.5, points: [[0, 0, 0], [12.5, 0, 0]] });
list = addMeasurement(list, { kind: 'distance', value: 3, points: [[0, 0, 0], [0, 0, 3]] });
list = addMeasurement(list, { kind: 'angle', value: 90, points: [[1, 0, 0], [0, 0, 0], [0, 1, 0]] });
check(list.length === 3, 'three measurements accumulate', String(list.length));
check(new Set(list.map((m) => m.id)).size === 3, 'ids are unique');
check(list[0].name === '距离-1' && list[1].name === '距离-2' && list[2].name === '角度-1',
  'auto names count within their kind', list.map((m) => m.name).join(', '));

const renamed = renameMeasurement(list, list[1].id, '  配合间隙  ');
check(renamed[1].name === '配合间隙', 'renaming trims and applies', String(renamed[1].name));
check(renameMeasurement(list, list[1].id, '   ')[1].name === null,
  'a blank name reverts to auto (null), it does not store whitespace');
check(removeMeasurement(list, list[0].id).length === 2, 'delete removes exactly one');
check(removeMeasurement(list, 'nope') === list || removeMeasurement(list, 'nope').length === 3,
  'deleting an unknown id is a no-op');
const afterDelete = removeMeasurement(list, list[1].id);
const added = addMeasurement(afterDelete, { kind: 'distance', value: 1, points: [[0, 0, 0], [1, 0, 0]] });
check(new Set(added.map((m) => m.id)).size === added.length, 'ids stay unique after a delete + add');
check(autoName('distance', afterDelete) === '距离-2', 'auto names do not reuse a deleted slot', autoName('distance', afterDelete));

check(measurementSummary({ id: 'm1', kind: 'angle', name: '夹角', value: 89.96, points: [] }) === '夹角 90.0°',
  'an angle summary is degrees to one decimal');
check(measurementSummary({ id: 'm2', kind: 'section', name: '截面', value: 235.619, points: [] }) === '截面 235.62mm²',
  'a section summary is mm² to two decimals');
check(measurementSummary({ id: 'm3', kind: 'hole', name: '孔', value: 12, points: [] }) === '孔 Ø12.00',
  'a hole summary carries the diameter symbol');

console.log(failures ? `\naccept-measure-families: ${failures} FAILURE(S)` : '\naccept-measure-families: PASS');
process.exit(failures ? 1 : 0);
