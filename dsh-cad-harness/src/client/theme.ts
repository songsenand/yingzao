// Theme plumbing: the `--cad-*` stylesheet, dark-mode detection, and a resolver
// for the few places that need a concrete colour instead of a CSS var.
//
// WHY A STYLESHEET. The panel is built from React inline styles (no CSS files),
// and 400-odd of those declarations read `T.<role>`. Turning every one of them
// into a function of the active theme would touch every render path and
// freeze module-level style objects at their import-time value. Tokens already
// are strings, so the cheap, correct move is to make each string a custom
// property reference: the browser resolves it per element, and an inline style
// written once follows `body[data-ds-dark-theme]` with no re-render.
//
// WHAT USES THE DARK FLAG DIRECTLY. Almost nothing: the stylesheet covers the
// DOM. Two consumers need a real colour value:
//   - 2D canvas drawing (`strokeStyle` cannot take `var(...)`), via
//     {@link resolveCssColor};
//   - nothing else in the panel today — three.js colours are scene colours, not
//     chrome (see tokens.ts).
//
// The host's theme plugin sets `body[data-ds-dark-theme]` before first paint
// (see @deepseek-ai/dsh-client-ui-theme), including when the user picked
// "system"; that attribute is the single source of truth. There is deliberately
// no `prefers-color-scheme` rule: a standalone page (the sandbox) opts into dark
// by setting the same attribute, so the sandbox and the host exercise one path.
import { DARK, LIGHT, cssVar, type CadTokenName } from './tokens.ts';

/** Attribute the DSH theme runtime puts on `body` for the dark palette. */
export const DARK_ATTRIBUTE = 'data-ds-dark-theme';

const declarations = (palette: Record<CadTokenName, string>): string =>
  (Object.keys(palette) as CadTokenName[])
    .map((name) => `${cssVar(name)}:${palette[name]};`)
    .join('');

/**
 * The stylesheet. Light lives on the root, dark overrides on the attribute; a
 * body-appended dialog (the export gate) therefore resolves the same values as
 * the panel without needing to be inside its subtree.
 */
export const THEME_CSS = [
  `:root{${declarations(LIGHT)}}`,
  `body[${DARK_ATTRIBUTE}],html[${DARK_ATTRIBUTE}]{${declarations(DARK)}}`,
  // Native controls (select options, scrollbars, the caret) follow the theme
  // too; without this a dark panel keeps a white `<select>` popup.
  '.cad-theme{color-scheme:light}',
  `body[${DARK_ATTRIBUTE}] .cad-theme,html[${DARK_ATTRIBUTE}] .cad-theme{color-scheme:dark}`,
].join('\n');

const STYLE_ID = 'cad-theme-tokens';

let styleElement: HTMLStyleElement | null = null;
let installs = 0;

/**
 * Install the token stylesheet once (idempotent, reference-counted).
 *
 * Returns a disposer; the last disposer removes the element. A hot reload that
 * replaces the client half without disposing reuses the element and refreshes
 * its text, so the palette can never go stale across an HMR cycle.
 */
export function installCadTheme(): () => void {
  if (typeof document === 'undefined') return () => {};
  installs++;
  const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (existing) {
    existing.textContent = THEME_CSS;
    styleElement = existing;
  } else {
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = THEME_CSS;
    document.head.appendChild(el);
    styleElement = el;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    installs = Math.max(0, installs - 1);
    if (installs === 0) {
      styleElement?.remove();
      styleElement = null;
    }
  };
}

/** Whether the host is currently in its dark palette. */
export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  return document.body?.hasAttribute(DARK_ATTRIBUTE)
    || document.documentElement.hasAttribute(DARK_ATTRIBUTE);
}

let probe: HTMLElement | null = null;

/**
 * Resolve a token value to a concrete CSS colour (`rgb(...)`).
 *
 * Only needed for a canvas context, which cannot resolve custom properties.
 * A non-`var()` value passes through untouched, so callers can mix themed chrome
 * (annotation hues from `T.danger` …) with scene colours without branching.
 */
export function resolveCssColor(value: string): string {
  if (!value || !value.startsWith('var(')) return value;
  if (typeof document === 'undefined' || !document.body) return value;
  // One hidden probe for the lifetime of the page: getComputedStyle resolves the
  // variable against the element's own ancestor chain (i.e. the active theme).
  if (!probe) {
    probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;pointer-events:none';
    document.body.appendChild(probe);
  }
  probe.style.color = '';
  probe.style.color = value;
  const resolved = getComputedStyle(probe).color;
  return resolved || value;
}
