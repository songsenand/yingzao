#!/usr/bin/env node
// Beam-model probe for the two ball-and-stick snap-fits.
//
// This is NOT the plugin's snap-fit operator (S1 is not implemented yet). It
// recomputes the cantilever estimate the examples already document, so the two
// real models can serve as S1 acceptance fixtures:
//   - fructose: INTERFACE.md §5 (4/3 lobes, 0.8 mm wall, δ=0.125/0.075 mm)
//   - glucose:  README.md §4 (≈5.8 N radial, ≈11 N insertion, 6–14 N band)
//
// Formula (root-fixed cantilever, load at the bead):
//   I = w t^3 / 12,  k = 3 E I / L^3,  F_lobe = k δ,
//   ε_root = 1.5 t δ / L^2.
// The model is an UPPER BOUND: the real cup wall is a curved shell, the load is
// distributed around the circumference, and friction/lead angle are not modelled.
//
// Run: cd dsh-cad-harness && node scripts/probe-snap-fit-examples.mjs

const E = 3500; // MPa, PLA+ as declared by the examples
const G = 9.81; // N/kg

const fructose = [
  { name: 'heavy', lobes: 4, widthMm: 8.9, thicknessMm: 0.8, leverMm: 4.0, interferenceMm: 0.125 },
  { name: 'light', lobes: 3, widthMm: 7.4, thicknessMm: 0.8, leverMm: 3.3, interferenceMm: 0.075 },
].map((c) => {
  const I = (c.widthMm * c.thicknessMm ** 3) / 12;
  const k = (3 * E * I) / c.leverMm ** 3;
  const lobeForceN = k * c.interferenceMm;
  const totalForceN = lobeForceN * c.lobes;
  const strainPct = (1.5 * c.thicknessMm * c.interferenceMm / c.leverMm ** 2) * 100;
  return {
    ...c,
    secondMomentMm4: +I.toFixed(4),
    lobeStiffnessNPerMm: +k.toFixed(2),
    lobeForceN: +lobeForceN.toFixed(2),
    totalForceN: +totalForceN.toFixed(1),
    strainPct: +strainPct.toFixed(2),
    equivalentKg: +(totalForceN / G).toFixed(2),
    weightMargin: +(totalForceN / (0.1 * G)).toFixed(0),
  };
});

const glucoseSource = {
  note: 'from examples/ball-and-stick/glucose-molecule/README.md §4; not independently recomputed here because the lobe effective width/curvature is not declared',
  radialN: 5.8,
  insertionN: 11,
  insertionBandN: [6, 14],
  pullTest: 'spring scale, after first print',
};

console.log(JSON.stringify({ E, fructose, glucoseSource }, null, 2));
