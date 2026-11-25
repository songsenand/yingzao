#!/usr/bin/env node
// Repro for P0-03: a solid sharp edge read as a thin shell.
//   DSH_CAD_PYTHON_ROOT=$HOME/.dsh/cad/runtime node --experimental-strip-types scripts/repro-printability-edge.mjs
import { openVersionStore } from '../src/host/version.ts';
import { checkPrintability } from '../src/host/inspect.ts';
const store = openVersionStore(new URL('../../examples/bicycle-derailleur-3spd-cq/cad-data', import.meta.url).pathname);
for (const v of ['v083', 'v085']) {
  const r = await checkPrintability(store, { versionId: v, edgeOnlyThinPct: 1.0 });
  console.log(`${v}: verdict=${r.verdict} minWall=${r.minWallMm} thin=${r.thinAreaPct}% samples=${r.thinSamples} edgeOnly=${r.edgeOnlyThinPct ?? 'no'}`);
  console.log(`  ${r.findings[0]}`);
}
