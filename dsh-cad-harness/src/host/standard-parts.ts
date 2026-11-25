/**
 * Seed standard-parts catalog for the elastic lane.
 *
 * This is deliberately small: a standard part is a *data* entry, not a solver.
 * The first entry is the two-color pen's assumed button spring; it exists to
 * prove the lookup and to keep the pen example honest until a vendor/measured
 * entry replaces it.
 *
 * Rules:
 *  - `standardId` fills only fields the interface did not declare; explicit
 *    manifest fields win, so an installation-specific override is visible.
 *  - `source` from the catalog is reported, never upgraded to `measured`.
 *  - unknown IDs are rejected by manifest validation (and returned as a detail
 *    by the operator for legacy/worker paths).
 */

export type StandardSpringSource = 'catalog' | 'measured' | 'estimated' | 'declared';
export type StandardSpringKind = 'coil-compression' | 'coil-extension';

export interface StandardSpring {
  id: string;
  kind: StandardSpringKind;
  name: string;
  freeLengthMm: number;
  stiffnessNPerMm: number;
  solidHeightMm?: number;
  outerDiameterMm?: number;
  maxTravelMm?: number;
  source: StandardSpringSource;
  note?: string;
}

export const STANDARD_SPRINGS: Readonly<Record<string, StandardSpring>> = {
  'comp-od5.4-w0.6-l30': {
    id: 'comp-od5.4-w0.6-l30',
    kind: 'coil-compression',
    name: 'Button compression spring (pen seed; assumed)',
    freeLengthMm: 30,
    stiffnessNPerMm: 0.5,
    solidHeightMm: 8,
    outerDiameterMm: 5.4,
    maxTravelMm: 20,
    source: 'estimated',
    note: 'Seed from the two-color pen BOM; generic PP spring, not measured.',
  },
  // The six DIN 2098 library springs. The catalog file carries wire/OD/free
  // length but no rate or solid height, so spring-behaviour could only be run
  // with a hand-entered k (the Bicycle sessions guessed 1.27/1.36/1.70 and 2.04).
  // These are CALCULATED from the catalog geometry — n = round(L/(3w)),
  // k = G·w^4/(8·(OD−w)^3·n), G=79 GPa — and marked `estimated`, never measured.
  'din2098.0.8x8x20': {
    id: 'din2098.0.8x8x20', kind: 'coil-compression', name: 'DIN 2098 compression spring w0.8×OD8×L20',
    freeLengthMm: 20, stiffnessNPerMm: 1.35, solidHeightMm: 6.4, outerDiameterMm: 8, maxTravelMm: 13.6,
    source: 'estimated', note: 'Calculated from catalog wire/OD/free length (8 turns, G=79 GPa); verify before load-bearing use.',
  },
  'din2098.1x10x25': {
    id: 'din2098.1x10x25', kind: 'coil-compression', name: 'DIN 2098 compression spring w1×OD10×L25',
    freeLengthMm: 25, stiffnessNPerMm: 1.69, solidHeightMm: 8, outerDiameterMm: 10, maxTravelMm: 17,
    source: 'estimated', note: 'Calculated from catalog wire/OD/free length (8 turns, G=79 GPa); verify before load-bearing use.',
  },
  'din2098.1.2x12x30': {
    id: 'din2098.1.2x12x30', kind: 'coil-compression', name: 'DIN 2098 compression spring w1.2×OD12×L30',
    freeLengthMm: 30, stiffnessNPerMm: 2.03, solidHeightMm: 9.6, outerDiameterMm: 12, maxTravelMm: 20.4,
    source: 'estimated', note: 'Calculated from catalog wire/OD/free length (8 turns, G=79 GPa); verify before load-bearing use.',
  },
  'din2098.1.5x16x40': {
    id: 'din2098.1.5x16x40', kind: 'coil-compression', name: 'DIN 2098 compression spring w1.5×OD16×L40',
    freeLengthMm: 40, stiffnessNPerMm: 1.82, solidHeightMm: 13.5, outerDiameterMm: 16, maxTravelMm: 26.5,
    source: 'estimated', note: 'Calculated from catalog wire/OD/free length (9 turns, G=79 GPa); verify before load-bearing use.',
  },
  'din2098.2x20x50': {
    id: 'din2098.2x20x50', kind: 'coil-compression', name: 'DIN 2098 compression spring w2×OD20×L50',
    freeLengthMm: 50, stiffnessNPerMm: 3.39, solidHeightMm: 16, outerDiameterMm: 20, maxTravelMm: 34,
    source: 'estimated', note: 'Calculated from catalog wire/OD/free length (8 turns, G=79 GPa); verify before load-bearing use.',
  },
  'din2098.2.5x25x60': {
    id: 'din2098.2.5x25x60', kind: 'coil-compression', name: 'DIN 2098 compression spring w2.5×OD25×L60',
    freeLengthMm: 60, stiffnessNPerMm: 4.23, solidHeightMm: 20, outerDiameterMm: 25, maxTravelMm: 40,
    source: 'estimated', note: 'Calculated from catalog wire/OD/free length (8 turns, G=79 GPa); verify before load-bearing use.',
  },
};

export const STANDARD_SPRING_IDS = Object.keys(STANDARD_SPRINGS);

export function standardSpring(id: string | undefined): StandardSpring | undefined {
  return id ? STANDARD_SPRINGS[id] : undefined;
}
