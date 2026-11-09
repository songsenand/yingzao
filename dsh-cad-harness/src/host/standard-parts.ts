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
};

export const STANDARD_SPRING_IDS = Object.keys(STANDARD_SPRINGS);

export function standardSpring(id: string | undefined): StandardSpring | undefined {
  return id ? STANDARD_SPRINGS[id] : undefined;
}
