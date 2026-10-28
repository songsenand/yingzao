// Acceptance for the geometry-sanity rule (2026-10-28).
//
// The criterion is a RATIO, and that is the point of this file: two parts with the
// SAME 100mm gap must be judged differently when one is 200mm wide and the other
// is 5mm. A fixed distance cannot do that — it would either flag a big machine's
// normal spacing or miss a tiny part lost in space.
//
//   ratio = gap to the nearest other part ÷ the part's own bbox diagonal
//   suspect when ratio > 5 · placeholder when triangles <= 24
//
//   node scripts/accept-geometry-sanity.mjs
const { suspectParts, formatSuspects, transformedAabb, SUSPECT_RATIO, PLACEHOLDER_TRIANGLES } =
  await import('../src/host/geometry-sanity.ts');

let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) fail++;
};

/** A box solid centred at `c` with half-extent `h`. */
const box = (name, c, h, triangles = 12) => ({
  name, triangles,
  min: [c[0] - h[0], c[1] - h[1], c[2] - h[2]],
  max: [c[0] + h[0], c[1] + h[1], c[2] + h[2]],
});

// ---------- 1. the same gap, two sizes: only the small part is an outlier ----------
{
  const big = box('big', [0, 0, 0], [100, 100, 100], 5000);   // 200mm cube, real geometry
  // A 5mm cube whose nearest face is a 100mm gap from the big one:
  //   big max.x = 100, pin half = 2.5, so centre = 100 + 100 + 2.5.
  const small = box('pin', [202.5, 0, 0], [2.5, 2.5, 2.5], 300);
  const suspects = suspectParts([big, small]);
  const names = suspects.map((s) => s.name);
  check('1  a 5mm pin 100mm away is an outlier', names.includes('pin'),
    JSON.stringify(suspects.map((s) => [s.name, s.ratio])));
  check('1b the 200mm base at the SAME 100mm gap is NOT', !names.includes('big'),
    `big ratio ${suspectParts([big, small]).find((s) => s.name === 'big')?.ratio ?? 'not flagged'}`);
  const pinRatio = suspects.find((s) => s.name === 'pin')?.ratio ?? 0;
  check('1c the ratio is what decides (pin > 5, big < 5)',
    pinRatio > SUSPECT_RATIO && (100 / Math.hypot(200, 200, 200)) < SUSPECT_RATIO,
    `pin ${pinRatio}× vs big ${(100 / Math.hypot(200, 200, 200)).toFixed(2)}×, floor ${SUSPECT_RATIO}`);
}

// ---------- 2. a part at the machine is not an outlier ----------
{
  const a = box('a', [0, 0, 0], [20, 20, 20], 500);
  const b = box('b', [62, 0, 0], [20, 20, 20], 500);     // 2mm gap, same size
  check('2  two parts 2mm apart are quiet', suspectParts([a, b]).length === 0,
    JSON.stringify(formatSuspects(suspectParts([a, b]))));
}

// ---------- 3. overlap counts as zero gap, not as "far" ----------
{
  const a = box('a', [0, 0, 0], [20, 20, 20], 500);
  const b = box('b', [5, 0, 0], [20, 20, 20], 500);      // intersecting
  check('3  overlapping parts are not reported (gap 0)', suspectParts([a, b]).length === 0);
}

// ---------- 4. placeholder geometry is reported, whatever its position ----------
{
  const crank = box('crank', [0, 0, 0], [5, 5, 5], 12);
  const plate = box('plate', [6, 0, 0], [10, 10, 10], 800);
  const s = suspectParts([crank, plate]).find((x) => x.name === 'crank');
  check('4  a 12-triangle cube is reported as a simple box', Boolean(s?.reasons.some((r) => /盒体/.test(r))),
    JSON.stringify(s?.reasons));
  check('4b …and the threshold is 24 triangles', PLACEHOLDER_TRIANGLES === 24);
}

// ---------- 5. the line carries its numbers and its connectivity ----------
{
  const far = box('dummy', [500, 500, 0], [5, 5, 5]);
  const body = box('body', [0, 0, 0], [20, 20, 20], 800);
  far.connected = false;
  const [line] = formatSuspects(suspectParts([far, body]));
  check('5  the line prints gap, size and ratio', /距最近零件 [\d.]+mm ÷ 自身 [\d.]+mm = [\d.]+×/.test(line), line);
  check('5b …and says it has no connection', /无任何连接/.test(line), line);
}

// ---------- 6. rotation is applied to the solid, not to the box's extents ----------
{
  const local = { min: [0, 0, 0], max: [10, 2, 2] };
  const turned = transformedAabb(local, [0, 0, 0], [0, 0, 90]);
  check('6  a bar rotated 90° about z swaps its x/y extents',
    Math.abs((turned.max[1] - turned.min[1]) - 10) < 1e-9 && Math.abs((turned.max[0] - turned.min[0]) - 2) < 1e-9,
    JSON.stringify([turned.min, turned.max]));
}

console.log(fail ? `\nFAILED (${fail})` : '\nOK');
process.exit(fail ? 1 : 0);
