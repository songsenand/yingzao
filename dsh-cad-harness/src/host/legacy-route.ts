// Legacy tool name → the callable surface action that now owns it.
//
// WHY: after the 2026-11-16 facade cutover the model's catalog contains only the
// nine `cad_*` surfaces. Internal code still throws errors with the legacy op
// name as a stage (`merge_parts: ...`) and, worse, with a paste-ready example
// (`merge_parts({...})`) — a call the model cannot make. This table lets
// `argError` render the callable form once, at the boundary, instead of every
// call site remembering to rewrite its copy.
//
// The table is populated by registration (the `surface` metadata already on each
// tool), so it cannot drift from the surface definitions.

export interface LegacyRoute {
  surface: string;
  action: string;
}

const routes = new Map<string, LegacyRoute>();

export function rememberLegacyRoute(name: string, route: LegacyRoute): void {
  routes.set(name, route);
}

export function legacyRouteOf(name: string): LegacyRoute | undefined {
  return routes.get(name);
}

/** `merge_parts` → `cad_part action=merge`; unknown names pass through unchanged. */
export function callableToolLabel(name: string): string {
  const route = routes.get(name);
  return route ? `${route.surface} action=${route.action}` : name;
}

/**
 * Rewrite a paste-ready legacy example into the surface call that does the same job.
 *
 *   merge_parts({ parts: [...] })  →  cad_part({ action: "merge", args: { parts: [...] } })
 *
 * Anything that is not literally `<legacy>(... )` is returned untouched: guessing
 * at a shape we did not verify would be worse than the old text.
 */
export function callableExample(name: string, example: string): string {
  const route = routes.get(name);
  if (!route) return example;
  const prefix = `${name}(`;
  const trimmed = example.trim();
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(')')) return example;
  const inner = trimmed.slice(prefix.length, -1).trim();
  if (!inner.startsWith('{') || !inner.endsWith('}')) return example;
  return `${route.surface}({ action: ${JSON.stringify(route.action)}, args: ${inner} })`;
}

/**
 * Translate legacy names inside prose (help text, catalog summaries, warnings).
 *
 * A description is read by the model even when nothing is wrong: "generate_part
 * creates the part automatically" is a dead call in a sentence. Replacing it at
 * the RENDER boundary keeps the stored legacy descriptions (which double as the
 * internal op documentation) intact while the model only ever sees callable names.
 */
export function callableProse(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [name, route] of [...routes.entries()].sort((a, b) => b[0].length - a[0].length)) {
    // These are also ordinary English words ("preflight wall screen", "deliver the
    // part", "analyze the field"). Rewriting them would corrupt the sentence, and a
    // reader does not mistake them for a call in that position.
    if (PROSE_EXCLUDED.has(name)) continue;
    out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), `${route.surface} action=${route.action}`);
  }
  return out;
}

const PROSE_EXCLUDED = new Set(['preflight', 'deliver', 'analyze']);
