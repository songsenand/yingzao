// Process profiles: the executable form of schemas/process-profile.schema.json.
//
// WHY THIS EXISTS. The manufacturing screen used to hold its thresholds as literals
// (`wallMinMm` default 1.2, `overhangDeg` 45). A literal is a claim with no author:
// it cannot be challenged, and — worse — it silently shapes the design, because a
// part converges on "whatever passes the default". A profile is the same number with
// a NAME, a PROCESS it governs, and a SOURCE saying where it came from.
//
// The two hard rules of the design (DECISION-LOG 2026-10-11, "工艺判定只做否决"):
//
//   1. A tool may EXCLUDE a process (it has a witness: rule + location + measured vs
//      required). It may never rank, score or recommend one — the objective values
//      (cost, yield, lead time, achievable tolerance) are not geometric facts and are
//      not ours to invent.
//   2. What cannot be decided from geometry must be DISCLOSED, never dropped. That is
//      why every rule carries `decidable`, and why the two lists below are DERIVED
//      from the profile rather than hand-maintained: a hand-written disclosure list
//      drifts, and the drift is silent.
//
// A profile is DATA. This module only validates, hashes and interprets it.

import { createHash } from 'node:crypto';

export type RuleDecidability = 'geometry' | 'declared-requirement' | 'not-decidable';
export type ProvenanceKind = 'vendor-spec' | 'standard' | 'measured' | 'literature' | 'rule-of-thumb' | 'assumed';

/** The named rules. Named, not expressions: a named rule answers "which rule judged this?". */
export const RULE_NAMES = [
  'wallMinMm', 'featureMinMm', 'gapMinMm', 'overhangDeg', 'bridgeMaxMm', 'holeAspectMax',
  'draftMinDeg', 'escapePassageMinMm', 'toolRadiusMm', 'tolMm', 'surfaceRaUm',
] as const;
export type RuleName = (typeof RULE_NAMES)[number];

const PROCESSES = ['FDM', 'SLA', 'SLS', 'MJF', 'injection', 'CNC-3axis', 'CNC-4axis', 'CNC-5axis', 'casting', 'die-casting', 'vacuum-forming', 'forging', 'turning', 'EDM', 'laser', 'waterjet', 'sheet-metal', 'extrusion'] as const;
const PROVENANCE_KINDS: ProvenanceKind[] = ['vendor-spec', 'standard', 'measured', 'literature', 'rule-of-thumb', 'assumed'];

export interface Provenance {
  kind: ProvenanceKind;
  ref?: string;
  date?: string;
  by?: string;
}

export interface ProfileRule {
  /** false = this rule does not govern this process. Must still be reported, with `reason`. */
  applies: boolean;
  decidable: RuleDecidability;
  /** Threshold. Lengths in mm, angles in degrees (repo-wide: mm, z-up). */
  value?: number | null;
  /** `min` = measured must be >= value; `max` = measured must be <= value. */
  direction?: 'min' | 'max';
  /** Required when applies=false: why this rule does not govern the process. */
  reason?: string;
  source?: Provenance;
  detail?: string;
}

export interface ProcessProfile {
  schemaVersion: 1;
  id: string;
  process: (typeof PROCESSES)[number];
  material?: string;
  machine?: string;
  description?: string;
  rules: Partial<Record<RuleName, ProfileRule>>;
  notes?: string;
}

export type ValidationResult =
  | { ok: true; profile: ProcessProfile }
  | { ok: false; errors: string[] };

/**
 * Validate a profile against the shipped schema's rules.
 *
 * Every message names the offending rule, because the profile is authored by a human
 * and a validation error is the only documentation they will read.
 */
export function validateProfile(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['profile must be a JSON object'] };
  }
  const p = input as Record<string, unknown>;
  if (p.schemaVersion !== 1) errors.push(`schemaVersion must be 1 (got ${JSON.stringify(p.schemaVersion)})`);
  if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(p.id)) {
    errors.push('id must match ^[a-z0-9][a-z0-9._-]*$ (e.g. "fdm-pla-0.4")');
  }
  if (typeof p.process !== 'string' || !(PROCESSES as readonly string[]).includes(p.process)) {
    errors.push(`process must be one of ${PROCESSES.join(' | ')} (got ${JSON.stringify(p.process)})`);
  }
  for (const key of Object.keys(p)) {
    if (!['schemaVersion', 'id', 'process', 'material', 'machine', 'description', 'rules', 'notes'].includes(key)) {
      errors.push(`unknown top-level key "${key}"`);
    }
  }
  const rules = p.rules;
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
    errors.push('rules must be an object');
    return { ok: false, errors };
  }
  for (const [name, raw] of Object.entries(rules as Record<string, unknown>)) {
    if (!(RULE_NAMES as readonly string[]).includes(name)) {
      errors.push(`unknown rule "${name}" — rules are named, so an unlisted name is a typo, not a new rule`);
      continue;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push(`rule ${name} must be an object`);
      continue;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.applies !== 'boolean') { errors.push(`rule ${name}: applies must be true or false`); continue; }
    if (typeof r.decidable !== 'string' || !['geometry', 'declared-requirement', 'not-decidable'].includes(r.decidable)) {
      errors.push(`rule ${name}: decidable must be geometry | declared-requirement | not-decidable`);
    }
    if (r.applies) {
      if (typeof r.value !== 'number') errors.push(`rule ${name}: applies=true needs a numeric value`);
      if (r.direction !== 'min' && r.direction !== 'max') errors.push(`rule ${name}: applies=true needs direction min | max`);
      const src = r.source as Record<string, unknown> | undefined;
      if (typeof src !== 'object' || src === null) {
        errors.push(`rule ${name}: applies=true needs a source — an unprovenanced number is an unverifiable claim`);
      } else if (typeof src.kind !== 'string' || !PROVENANCE_KINDS.includes(src.kind as ProvenanceKind)) {
        errors.push(`rule ${name}: source.kind must be one of ${PROVENANCE_KINDS.join(' | ')}`);
      }
    } else if (typeof r.reason !== 'string' || r.reason.trim() === '') {
      errors.push(`rule ${name}: applies=false needs a reason — "not applicable" must be said out loud, never left implicit`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, profile: p as unknown as ProcessProfile };
}

/** Stable JSON (sorted keys) so the same profile always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Content hash of a profile, recorded with every run.
 *
 * A verdict without its premise is not evidence: a year from now `excluded` must be
 * answerable with "excluded against WHICH profile, saying WHAT". The hash is what makes
 * that answerable even after the profile file is edited.
 */
export function profileHash(profile: ProcessProfile): string {
  return createHash('sha256').update(canonical(profile)).digest('hex').slice(0, 16);
}

/** A rule the profile declines to govern: reported, with its reason. */
export interface NotApplicableRule { rule: RuleName; reason: string }
/** A rule the profile declares but a tool cannot decide from the mesh alone. */
export interface UnevaluableRule { rule: RuleName; decidable: RuleDecidability; reason: string }

/**
 * The two disclosure lists, DERIVED from the profile.
 *
 * `notApplicable` = the process has no such constraint (powder bed has no overhang).
 * `unevaluable`   = the constraint is real but not a geometric fact (cost, tolerance
 *                   capability) or simply was never declared here.
 *
 * The distinction matters: reporting an SLS part's overhang as "needs support" is not
 * conservative, it is WRONG; and a missing number is not "no constraint".
 */
export function disclosureLists(profile: ProcessProfile): { notApplicable: NotApplicableRule[]; unevaluable: UnevaluableRule[] } {
  const notApplicable: NotApplicableRule[] = [];
  const unevaluable: UnevaluableRule[] = [];
  for (const name of RULE_NAMES) {
    const rule = profile.rules[name];
    if (rule === undefined) {
      unevaluable.push({ rule: name, decidable: 'geometry', reason: 'not declared in this profile — a missing number is not "no constraint"' });
      continue;
    }
    if (!rule.applies) {
      notApplicable.push({ rule: name, reason: rule.reason ?? '(no reason given)' });
      continue;
    }
    if (rule.decidable !== 'geometry') {
      unevaluable.push({
        rule: name,
        decidable: rule.decidable,
        reason: rule.decidable === 'declared-requirement'
          ? 'needs a requirement declared elsewhere to compare against (a capability is not a violation)'
          : 'not a geometric fact at all — never used to exclude',
      });
    }
  }
  return { notApplicable, unevaluable };
}

/** Rules a tool can actually evaluate from the mesh alone, with their thresholds. */
/**
 * Does `measured` violate a declared rule?
 *
 * `direction` was declared, validated, returned by `evaluableRules` — and then IGNORED by
 * every comparison, which all assumed "smaller is worse". A profile declaring
 * `wallMinMm: { direction: 'max' }` was therefore read as a minimum and nothing said so
 * (2026-10-23 audit, FIX-B6). One function, used by every rule, so the declaration means
 * what it says.
 *
 *   direction 'min'  -> the value is a LOWER bound; violating means measured < value
 *   direction 'max'  -> the value is an UPPER bound; violating means measured > value
 */
/**
 * The width of a rule's "gray band", from the measurement's OWN resolution.
 *
 * DESIGN §27.4: a band must not be invented — a sampled field knows how far apart its
 * samples are, and that spacing is the smallest difference it can honestly resolve. For
 * the wall screen the samples sit on the surface with spacing ≈ sqrt(area / count)
 * (2026-10-23, user decision: derive, do not declare a new constant).
 *
 * Returns 0 when the measurement cannot say (no area, no samples), and callers then fall
 * back to the absolute band — an unknown resolution must not pretend to be a known one.
 */
export function measuredResolutionMm(input: { surfaceAreaMm2?: number; sampled?: number }): number {
  const area = input.surfaceAreaMm2 ?? 0;
  const sampled = input.sampled ?? 0;
  if (!(area > 0) || !(sampled > 0)) return 0;
  return Math.sqrt(area / sampled);
}

export function violatesRule(
  measured: number,
  rule: { value: number; direction: 'min' | 'max' },
): boolean {
  return rule.direction === 'min' ? measured < rule.value : measured > rule.value;
}

export function evaluableRules(profile: ProcessProfile): { rule: RuleName; value: number; direction: 'min' | 'max' }[] {
  const out: { rule: RuleName; value: number; direction: 'min' | 'max' }[] = [];
  for (const name of RULE_NAMES) {
    const rule = profile.rules[name];
    if (!rule || !rule.applies || rule.decidable !== 'geometry') continue;
    if (typeof rule.value !== 'number' || (rule.direction !== 'min' && rule.direction !== 'max')) continue;
    out.push({ rule: name, value: rule.value, direction: rule.direction });
  }
  return out;
}

/**
 * The inherited defaults, as a profile — and it says so.
 *
 * This is the SAME 1.2mm / 45° that used to be a literal, reproduced with
 * `source.kind: "assumed"`. It exists so that "no profile declared" still has a name,
 * a hash and an honest provenance line, instead of being an anonymous default that
 * everyone assumes was calibrated. It is NOT a recommendation to use FDM.
 */
export function builtinDefaultProfile(): ProcessProfile {
  const assumed = (ref: string): Provenance => ({ kind: 'assumed', ref });
  return {
    schemaVersion: 1,
    id: 'fdm-pla-0.4-builtin-default',
    process: 'FDM',
    material: 'PLA',
    machine: '0.4mm nozzle, 0.2mm layer',
    description: 'Built-in fallback used when no profile was declared. Reproduces the literals that check_printability hardcoded (wallMinMm 1.2, overhangDeg 45).',
    rules: {
      wallMinMm: { applies: true, decidable: 'geometry', value: 1.2, direction: 'min', source: assumed('inherited literal; NOT calibrated against any machine') },
      overhangDeg: { applies: true, decidable: 'geometry', value: 45, direction: 'max', source: assumed('inherited literal; NOT calibrated against any machine') },
      draftMinDeg: { applies: false, decidable: 'geometry', reason: 'FDM has no mold release.' },
      escapePassageMinMm: { applies: false, decidable: 'geometry', reason: 'No trapped medium to evacuate.' },
      toolRadiusMm: { applies: false, decidable: 'geometry', reason: 'Not a cutting process.' },
    },
    notes: 'Every declared number here is `assumed`. That is the point: it makes the inherited default visible instead of authoritative.',
  };
}
