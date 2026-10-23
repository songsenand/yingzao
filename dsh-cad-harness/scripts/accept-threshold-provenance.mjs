// Acceptance for "a threshold is a declaration with an author" (2026-10-23 audit, FIX-B6;
// DESIGN §27.1/§27.4).
//
// Three defects shared one shape:
//   * `direction` was declared, validated and returned — and then IGNORED by every
//     comparison (all assumed "smaller is worse"), so a profile saying `max` was read as a
//     minimum with no warning;
//   * `analyze` labelled its own invented band "(declared)" — a declaration with no author;
//   * the stress `badFactor` divides the strength to produce the ALLOWABLE stress, and
//     nothing in the report said where 1.5 came from.
//
//   node scripts/accept-threshold-provenance.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { violatesRule, measuredResolutionMm } = await import('../src/host/process-profile.ts');
const TOOLS_SRC = await readFile(join(ROOT, 'src', 'host', 'tools.ts'), 'utf8');
const { JOINT_DRIFT_TOLERANCE_MM } = await import('../src/host/motion.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ── direction is consumed ──────────────────────────────────────────────────
const min = { value: 1.2, direction: 'min' };
const max = { value: 45, direction: 'max' };
check(violatesRule(1.19, min) === true, 'min: below the value violates', '1.19 < 1.2');
check(violatesRule(1.2, min) === false, 'min: exactly the value does NOT violate');
check(violatesRule(1.21, min) === false, 'min: above the value is fine');
check(violatesRule(45.1, max) === true, 'max: above the value violates', '45.1 > 45');
check(violatesRule(45, max) === false, 'max: exactly the value does NOT violate');
check(violatesRule(44, max) === false, 'max: below the value is fine');

// ── the band's width is the measurement's resolution (B2c) ─────────────────
check(measuredResolutionMm({ surfaceAreaMm2: 1000, sampled: 100 }).toFixed(4) === '3.1623',
  'resolution = sqrt(area / samples)', measuredResolutionMm({ surfaceAreaMm2: 1000, sampled: 100 }).toFixed(4));
check(measuredResolutionMm({ surfaceAreaMm2: 0, sampled: 100 }) === 0, 'no area -> no resolution (0)');
check(measuredResolutionMm({ surfaceAreaMm2: 100, sampled: 0 }) === 0, 'no samples -> no resolution (0)');
check(measuredResolutionMm({}) === 0, 'nothing known -> 0, never a made-up spacing');
check(/scaleLo: wallResolutionMm > 0 \? wallResolutionMm : wallMin/.test(TOOLS_SRC),
  'analyze uses the resolution as the band width, and falls back to the absolute edge');

// ── no comparison bypasses it ──────────────────────────────────────────────
const tools = TOOLS_SRC;
const bare = [
  /minWallMm\s*<\s*wall\.value/,
  /radiusMm\s*<\s*toolRadius\.value/,
  /aspect\s*>\s*holeAspect\.value/,
];
for (const re of bare) check(!re.test(tools), `no bare comparison remains: ${re}`);
check((tools.match(/violatesRule\(/g) ?? []).length >= 3, 'all three rule comparisons use violatesRule',
  `${(tools.match(/violatesRule\(/g) ?? []).length}`);

// ── the band says where it came from ──────────────────────────────────────
check(/NO process profile/.test(tools), 'analyze admits when its band has no profile');
check(/profile \$\{prof\.id\} \(hash \$\{profileHash\(prof\)\}\) rule wallMinMm=/.test(tools),
  'and names profile id + content hash when it has one');

// ── the stress factor is disclosed where it decides the allowable ─────────
check(/warnFactor, badFactor, factorSource: FACTOR_SOURCE/.test(tools),
  'the stress report carries the factors AND their source');
check(/strength\/warn, strength\/bad/.test(tools), 'and says what the factors mean (they divide strength)');

// ── one drift tolerance, named ────────────────────────────────────────────
check(JOINT_DRIFT_TOLERANCE_MM === 2, 'the drift tolerance is exported and equal to the old literal', String(JOINT_DRIFT_TOLERANCE_MM));
const motion = await readFile(join(ROOT, 'src', 'host', 'motion.ts'), 'utf8');
const bareDrift = [/drift\s*>\s*2\b/, /maxJointDriftMm\s*<=\s*2\b/].filter((re) => re.test(motion));
check(bareDrift.length === 0, 'motion.ts has no bare drift literal left', bareDrift.map(String).join(','));
check((motion.match(/JOINT_DRIFT_TOLERANCE_MM/g) ?? []).length >= 2, 'and both comparison sites use it');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
