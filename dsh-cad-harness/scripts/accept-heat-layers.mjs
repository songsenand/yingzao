// Acceptance: the user-facing heatmap exposes every available layer, each with its
// own legend; the default is still fused. The panel selector paints one layer at a
// time — layers are not summed into a score.
//
//   node --experimental-strip-types scripts/accept-heat-layers.mjs

const { heatLayers, pickHeatLayer } = await import('../src/client/heat.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const samples = (v) => Array.from({ length: 8 }, (_, i) => ({ p: [i, 0, 0], v }));
const full = {
  id: 'accept',
  versionId: 'v001',
  normalization: {
    wall: { warnAt: 1.2, badAt: 0.48 },
    overhang: { warnAt: 20 },
    'von-mises': { warnAt: 10, badAt: 16 },
  },
  samples: { fused: samples(0.7), wall: samples(0.5), overhang: samples(25), 'von-mises': samples(12) },
};
const layers = heatLayers(full);
check(layers.map((l) => l.id).join(',') === 'fused,wall,overhang,von-mises', 'all four layers are exposed in default order', layers.map((l) => l.id).join(','));
check(layers.every((l) => typeof l.label === 'string' && l.label.length > 0), 'each layer has a selector label');
check(layers.every((l) => typeof l.legend === 'string' && l.legend.length > 0), 'each layer has its own legend');
check(pickHeatLayer(full)?.id === 'fused', 'the default layer is still fused');
const onlyWall = { ...full, samples: { wall: samples(0.5) } };
check(heatLayers(onlyWall).map((l) => l.id).join(',') === 'wall', 'missing layers are not invented', heatLayers(onlyWall).map((l) => l.id).join(','));
const tiny = { ...full, samples: { wall: samples(0.5).slice(0, 7) } };
check(heatLayers(tiny).length === 0, 'a layer with fewer than 8 samples is not drawn');

console.log(failures === 0 ? '\nOK' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
