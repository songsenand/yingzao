// Design tokens: the palette and the type scale, named once.
//
// WHY: the panel grew to ~3 700 lines while every new element picked its own grey.
// `#8a94a0` alone appeared 34 times, `#c0392b` 21 — the same "muted" and "danger"
// spelled differently in places, which is how two elements that should match end
// up 2% off. A token is not an abstraction tax: it is the ONLY place a colour is
// allowed to be a literal.
//
// Naming is by ROLE, not by hue: `danger` survives a palette change, `red` does
// not. The light values below are the exact ones already in use, so migrating a
// site is a pure substitution — no light-mode visual change is intended, and
// `assert=layout` plus the screenshot comparisons are how we know nothing moved.
//
// WHY TWO PALETTES. The panel is mounted inside the DSH Web UI, which has a dark
// mode (`body[data-ds-dark-theme]`). Fixed light chrome there gave light text on
// white plates: the buttons and labels in the simulation viewport were the
// loudest case, but the whole panel was affected. Every colour token therefore
// resolves through a CSS custom property (`--cad-*`), so an inline style can be
// written once and still follow the active theme; `src/client/theme.ts` owns the
// stylesheet and the light/dark declarations.
//
// WHY THE DARK HALF IS NOT JUST "INVERT". A dark UI needs *lighter* accents on
// a dark ground (a 2f6fdb link is dim against 1f252c), and pale semantic plates
// (#fdecea "error") need a dark tint of the same hue, not a grey. The values
// below are chosen for contrast against `plate`; `accept-tokens.mjs` proves every
// token has a dark value, and `assert=theme` proves the rendered panel has no
// light-on-light text in either mode.
//
// Scene colours (the blue part body, annotation hues, chart series) are NOT
// theme chrome: they sit on the 3D ground the user picked and must stay stable.
// They live here too so this file stays the one literal table, but they are
// plain hex and are never themed.
//
// This file is the token TABLE: it is the one place `#rrggbb` is expected. A lint
// (`accept-tokens.mjs`) keeps the count outside it from growing.

/** The light palette (= the values that shipped before dark mode existed). */
export const LIGHT = {
  // ── ink ──────────────────────────────────────────────────────────────────
  /** Primary text. */
  ink: '#26303a',
  /** Secondary text: labels, provenance, "what this is". */
  soft: '#5b6673',
  /** Tertiary: timestamps, counts, "·" separators. */
  muted: '#8a94a0',
  /** On a solid accent/danger fill. Same in both palettes. */
  white: '#ffffff',

  // ── lines and surfaces ───────────────────────────────────────────────────
  /** A control's outline. */
  line: '#d5d9dd',
  /** A panel's outer edge. */
  edge: '#e3e7ea',
  /** A hairline inside a block. */
  divider: '#f0f2f4',
  /** A section separator. */
  border: '#eef1f3',
  /** A raised plate (cards, chips, inputs). */
  plate: '#ffffff',
  /** A recessed ground (overlay backdrops, inset frames). */
  ground: '#f7f9fb',
  /** The bottom status band / a slightly sunk strip. */
  sunk: '#fafbfc',
  /** The empty stage behind a viewport. */
  stage: '#f0f0f0',

  // ── semantic accents ─────────────────────────────────────────────────────
  /** Action / selection / links. */
  accent: '#2f6fdb',
  /** Accent at 8%: selected rows, active chips. */
  accentSoft: '#eaf3fc',
  /** A softer accent outline (focus rings, chips). */
  accentLine: '#bcd6f5',
  /** Accent ink on `accentSoft`. */
  accentInk: '#1f4e79',
  /** A filled primary action. */
  accentSolid: '#2f6fdb',
  /** A selected/active control outline (the viewport tool strip). */
  active: '#4a7dbd',
  /** Background of a selected control. */
  activeSoft: '#e8f0fa',
  /** "Look at this" — the evidence verdict, the history banner. */
  warn: '#b8860b',
  /** Warning ink on a pale plate. */
  warnInk: '#8a5a00',
  /** A pale warning plate (notice bars). */
  warnSoft: '#fdf3e3',
  /** The border of a warning plate. */
  warnLine: '#e0c08a',
  /** A translucent warning wash (inline call-outs). */
  warnWash: 'rgba(184,134,11,0.15)',
  /** Pass / current / approved. */
  ok: '#27ae60',
  /** Success ink on a pale plate. */
  okInk: '#1e8449',
  /** A translucent success wash. */
  okWash: 'rgba(39,174,96,0.10)',
  /** Refused / failed / destructive. */
  danger: '#c0392b',
  /** Destructive ink on a pale plate. */
  dangerInk: '#a4531c',
  /** A pale error plate (error bars, verdict chips). */
  dangerSoft: '#fdecea',
  /** The border of an error plate. */
  dangerLine: '#e6b0aa',
  /** Error ink on a pale plate. */
  dangerText: '#a93226',
  /** A translucent error wash. */
  dangerWash: 'rgba(192,57,43,0.08)',
  /** Informational blue (the fluid entry point). */
  info: '#2c81ba',
  infoSoft: '#e8f4fa',
  infoInk: '#1f4f8f',
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

  // ── translucent chrome over the 3D canvas ────────────────────────────────
  /** A viewport-corner chip / the 复原 button. */
  chip: 'rgba(255,255,255,0.86)',
  /** A pinned read-out over the model. */
  chipStrong: 'rgba(255,255,255,0.93)',
  /** A floating menu over the viewport. */
  chipMenu: 'rgba(255,255,255,0.97)',

  // ── elevation ────────────────────────────────────────────────────────────
  /** A chip's shadow. */
  shadowSm: '0 1px 3px rgba(20,30,40,0.14)',
  /** A floating card / sheet. */
  shadowMd: '0 10px 30px rgba(20,30,40,0.20)',
  /** A dialog. */
  shadowLg: '0 18px 60px rgba(0,0,0,0.30)',
  /** A modal over the panel. */
  shadowXl: '0 10px 40px rgba(0,0,0,0.25)',
  /** A selected-control focus ring (accent). */
  ringAccent: '0 0 0 2px rgba(52,152,219,0.25)',
  /** A selected-control focus ring (compare orange). */
  ringCompare: '0 0 0 2px rgba(224,122,63,0.18)',
  /** The dimmer behind the product navigator. */
  scrimSoft: 'rgba(20,24,30,0.35)',
  /** The dimmer behind a modal dialog. */
  scrimStrong: 'rgba(20,24,30,0.45)',
} as const;

/** The dark palette: the same roles, re-valued for a dark ground. */
export const DARK: Record<keyof typeof LIGHT, string> = {
  ink: '#e7eaef',
  soft: '#aeb7c2',
  muted: '#8b95a3',
  white: '#ffffff',

  line: '#3c444f',
  edge: '#303842',
  divider: '#2a313a',
  border: '#2b333c',
  plate: '#1f252c',
  ground: '#181d23',
  sunk: '#1a2027',
  stage: '#12161a',

  accent: '#7aa7ff',
  accentSoft: '#1d2c42',
  accentLine: '#39537a',
  accentInk: '#a9c9f5',
  accentSolid: '#2f6fdb',
  active: '#7aa7ff',
  activeSoft: '#1d2c42',
  warn: '#e0b341',
  warnInk: '#f0cb74',
  warnSoft: '#3a2f18',
  warnLine: '#5f4d24',
  warnWash: 'rgba(224,179,65,0.15)',
  ok: '#4fce7f',
  okInk: '#7fdba4',
  okWash: 'rgba(79,206,127,0.14)',
  danger: '#ff7b6e',
  dangerInk: '#ffab8f',
  dangerSoft: '#3a211f',
  dangerLine: '#5f342f',
  dangerText: '#ff9d92',
  dangerWash: 'rgba(255,123,110,0.12)',
  info: '#63b8e8',
  infoSoft: '#14303d',
  infoInk: '#a8d8f5',
  compare: '#f0955f',
  compareInk: '#f4b083',
  thick: '#46c6d2',
  clip: '#c08de0',
  measure: '#ff5f6b',

  chip: 'rgba(31,37,44,0.90)',
  chipStrong: 'rgba(31,37,44,0.94)',
  chipMenu: 'rgba(31,37,44,0.97)',

  shadowSm: '0 1px 3px rgba(0,0,0,0.55)',
  shadowMd: '0 10px 30px rgba(0,0,0,0.55)',
  shadowLg: '0 18px 60px rgba(0,0,0,0.60)',
  shadowXl: '0 10px 40px rgba(0,0,0,0.55)',
  ringAccent: '0 0 0 2px rgba(122,167,255,0.35)',
  ringCompare: '0 0 0 2px rgba(240,149,95,0.30)',
  scrimSoft: 'rgba(0,0,0,0.45)',
  scrimStrong: 'rgba(0,0,0,0.55)',
};

export type CadTokenName = keyof typeof LIGHT;

/** The CSS custom property carrying one token. */
export const cssVar = (name: CadTokenName): string => `--cad-${name}`;

/**
 * The token table every component imports.
 *
 * Each colour is `var(--cad-<name>, <light value>)`: the fallback keeps the
 * panel rendering its light palette even before the stylesheet is installed
 * (sandbox, tests, a client half loaded without `installCadTheme`), and the
 * variable lets one inline style follow the active theme without re-rendering.
 */
export const T = Object.fromEntries(
  (Object.keys(LIGHT) as CadTokenName[]).map((name) => [name, `var(${cssVar(name)}, ${LIGHT[name]})`]),
) as Record<CadTokenName, string>;

// ── type scale ─────────────────────────────────────────────────────────────
// Numeric, not colours: the same names as before, kept for call sites that want
// a named step instead of a bare number.
export const FS = {
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
} as const;

/** Space / radius steps. */
export const SP = { sp2: 2, sp3: 3, sp4: 4, sp6: 6, sp8: 8, sp10: 10, r3: 3, r4: 4, r6: 6, r8: 8, r10: 10 } as const;

// ── scene colours (NOT theme chrome) ───────────────────────────────────────
// These are painted by three.js / a 2D canvas / the annotation overlay, and must
// NOT become `var(...)`: a canvas context cannot resolve a custom property, and
// they describe the model and its annotations, not the UI around it.

/** The part body and its section-interior tint. */
export const SCENE = {
  part: '#7aa7d9',
  interior: '#41608a',
  /** The compare inset's two versions. */
  compareHere: '#2563eb',
  compareThere: '#f97316',
  /** A fixed (grounded) body in a simulation. */
  fixed: '#9aa5b1',
  /** A neutral stage behind a picture-in-picture viewport. */
  insetGround: '#f2f4f7',
  /** Text baked into an exported canvas image (always white on its plate). */
  labelInk: '#ffffff',
  /** The drag-in-progress annotation fill. */
  annFill: 'rgba(231,76,60,0.12)',
  /** The transparent wall mesh in a fluid replay. */
  fluidWall: '#7a8aa0',
  /** The low / high ends of the speed legend. */
  speedLow: '#3457d5',
  speedHigh: '#e5261a',
  /** The viewport grounds (user-selectable studio backdrops). */
  groundPaper: '#f2f3f5',
  groundWarm: '#e6e0d6',
  groundGraphite: '#39424d',
  groundMidnight: '#1c2733',
  /** Overlay ink for a light / dark ground. */
  inkOnDark: '#eef1f4',
  haloOnDark: '#1c2733',
  inkOnLight: '#26303a',
  haloOnLight: '#f2f3f5',
  /** The instrument plate's wash over the 3D ground. */
  overlayPlate: 'rgba(255,255,255,0.55)',
  /** The triad dot and the default overlay ink (used when no ground is given). */
  overlayDot: '#6b7280',
  overlayInk: '#26303a',
  overlayHalo: '#f0f0f0',
} as const;

/** Annotation box colours, in cycle order. */
export const ANN_PALETTE = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'] as const;

/** Simulated bodies without a declared colour, in cycle order. */
export const PART_PALETTE = ['#4a7dbd', '#c0392b', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'] as const;

/** Chart series, in cycle order. */
export const CHART_PALETTE = ['#2f6fdb', '#c0392b', '#27ae60'] as const;

/** Coordinate-triad axis colours. */
export const AXIS_PALETTE = { x: '#c0392b', y: '#1e8449', z: '#2471a3' } as const;
