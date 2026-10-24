// Design tokens: the palette and the type scale, named once.
//
// WHY: the panel grew to ~3 700 lines while every new element picked its own grey.
// `#8a94a0` alone appeared 34 times, `#c0392b` 21 — the same "muted" and "danger"
// spelled differently in places, which is how two elements that should match end
// up 2% off. A token is not an abstraction tax: it is the ONLY place a colour is
// allowed to be a literal.
//
// Naming is by ROLE, not by hue: `danger` survives a palette change, `red` does
// not. The values below are the exact ones already in use, so migrating a site is
// a pure substitution — no visual change is intended, and `assert=layout` plus the
// screenshot comparisons are how we know nothing moved.
//
// This file is the token TABLE: it is the one place `#rrggbb` is expected. A lint
// (`accept-tokens.mjs`) keeps the count outside it from growing.

export const T = {
  // ── ink ──────────────────────────────────────────────────────────────────
  /** Primary text. */
  ink: '#26303a',
  /** Secondary text: labels, provenance, "what this is". */
  soft: '#5b6673',
  /** Tertiary: timestamps, counts, "·" separators. */
  muted: '#8a94a0',
  white: '#fff',

  // ── lines and surfaces ───────────────────────────────────────────────────
  /** A control's outline. */
  line: '#d5d9dd',
  /** A panel's outer edge. */
  edge: '#e3e7ea',
  /** A hairline inside a block. */
  divider: '#f0f2f4',
  /** A section separator. */
  border: '#eef1f3',
  /** A raised plate (cards, chips). */
  plate: '#ffffff',
  /** A recessed ground (overlay backdrops, inset frames). */
  ground: '#f7f9fb',

  // ── semantic accents ─────────────────────────────────────────────────────
  /** Action / selection / links. */
  accent: '#2f6fdb',
  /** Accent at 8%: selected rows, active chips. */
  accentSoft: '#eaf3fc',
  /** A softer accent outline (focus rings, chips). */
  accentLine: '#bcd6f5',
  /** "Look at this" — the evidence verdict, the history banner. */
  warn: '#b8860b',
  /** Warning ink on a pale plate. */
  warnInk: '#8a5a00',
  /** Pass / current / approved. */
  ok: '#27ae60',
  /** Refused / failed / destructive. */
  danger: '#c0392b',
  /** Destructive ink on a pale plate. */
  dangerInk: '#a4531c',
  /** The comparison counterpart (orange ghost). */
  compare: '#e07a3f',
  /** Comparison ink. */
  compareInk: '#c2652a',
  /** Wall thickness. */
  thick: '#00838f',
  /** Section cut. */
  clip: '#8e44ad',
  /** Measurement. */
  measure: '#ff3040',

  // ── type scale ───────────────────────────────────────────────────────────
  /** The smallest label (badges, timestamps in a dense row). */
  fs10: 10,
  /** The workhorse label. */
  fs11: 11,
  /** Body text. */
  fs12: 12,
  /** A section heading. */
  fs13: 13,
  /** The panel's one display size (rare). */
  fs14: 14,

  // ── space / radius ───────────────────────────────────────────────────────
  sp2: 2,
  sp3: 3,
  sp4: 4,
  sp6: 6,
  sp8: 8,
  sp10: 10,
  r3: 3,
  r4: 4,
  r6: 6,
  r8: 8,
  r10: 10,
} as const;
