// An argument error must let the caller FIX the call without guessing.
//
// WHY: the caller is a model reading one line of text. "needs a non-empty name" tells it
// the field but not the shape, the units or what a good value looks like — so it guesses,
// and guessing costs a round trip. Every argument error therefore states, in this order:
//
//   <tool>: <field> <what is wrong>
//     received: <what actually arrived>      (when known)
//     accepts:  <type / units / allowed values / the ids that DO exist>
//     example:  <one runnable call>          (when the shape is unambiguous)
//
// The tool name in the message is translated to the CALLABLE surface action
// (`merge_parts` → `cad_part action=merge`) when the model-facing catalog hides
// the legacy name; a paste-ready `example:` is wrapped the same way. See
// `legacy-route.ts` for why a dead tool name is a defect, not jargon.

// This is the sibling of `versionNotFound()` (which lists the ids that exist) and of the
// generated docs/TOOL-CONTRACTS.md (the full parameter reference). Never invent an example
// for a shape you have not verified — point at the contract sheet instead.

import { callableExample, callableToolLabel } from './legacy-route.ts';

function render(received: unknown): string {
  if (received === undefined) return 'undefined';
  if (typeof received === 'string') return JSON.stringify(received);
  try {
    const s = JSON.stringify(received);
    return s === undefined ? String(received) : s.length > 120 ? `${s.slice(0, 117)}…` : s;
  } catch {
    return String(received);
  }
}

export function argError(
  tool: string,
  field: string,
  problem: string,
  accepts: string,
  opts: { example?: string; received?: unknown } = {},
): Error {
  const lines = [`${callableToolLabel(tool)}: ${field} ${problem}`];
  if (opts.received !== undefined) lines.push(`  received: ${render(opts.received)}`);
  lines.push(`  accepts:  ${accepts}`);
  if (opts.example) lines.push(`  example:  ${callableExample(tool, opts.example)}`);
  return new Error(lines.join('\n'));
}
