#!/usr/bin/env node
// Repro for P1-04: the turning screen measured Ø from the world axis.
import { readFile } from 'node:fs/promises';
import { parseBinaryStl } from '../src/host/mesh.ts';
import { maxRadiusAboutCentre } from '../src/host/turning.ts';
const root = new URL('../../examples/bicycle-derailleur-3spd-cq/cad-data/versions', import.meta.url).pathname;
for (const v of ['v062', 'v063']) {
  const m = parseBinaryStl(new Uint8Array(await readFile(`${root}/${v}/model.stl`)));
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < m.vertProperties.length; i += 3) for (let k = 0; k < 3; k++) {
    const x = m.vertProperties[i + k];
    if (x < mn[k]) mn[k] = x;
    if (x > mx[k]) mx[k] = x;
  }
  const c = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2);
  console.log(`${v}: fixed Ø${(2 * maxRadiusAboutCentre(m.vertProperties, c, 'z')).toFixed(2)} · old world-axis Ø${(2 * maxRadiusAboutCentre(m.vertProperties, [0, 0, 0], 'z')).toFixed(2)}`);
}
