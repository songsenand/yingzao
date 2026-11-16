// Opt-in Phase-2 registration: keep `registerCadTools` unchanged, capture the
// final definitions through a proxy, then add the prototype surface.
//
// Why a wrapper instead of editing tools.ts: tools.ts is under active parallel
// work (physics/measure migration). This module keeps the surface experiment out
// of that file and makes the switch explicit at the plugin entry point.

import { registerCadTools, rememberCadToolName } from './tools.ts';
import { buildCadInspectSurface } from './surface-inspect.ts';
import { buildCadCheckSurface } from './surface-check.ts';
import { buildCadSessionSurface } from './surface-session.ts';
import { buildCadPartSurface } from './surface-part.ts';
import { buildCadAssemblySurface } from './surface-assembly.ts';
import { buildCadSeeSurface } from './surface-see.ts';
import { buildCadPythonSurface } from './surface-python.ts';
import { buildCadDeliverSurface } from './surface-deliver.ts';
import { buildCadSimulateSurface } from './surface-simulate.ts';
import type { LegacyTool } from './surface.ts';
import { withOutputContract } from './tool-contract.ts';

export interface SurfaceRegisterScope {
  toolScope?: string;
  presets?: readonly string[];
  toolSurfaces?: readonly string[];
  /** Phase 3 cutover probe: do not expose these legacy names. */
  hideLegacy?: readonly string[] | 'all';
}

/**
 * Register the legacy CAD tools, then optionally the inspect surface.
 *
 * Without `toolSurfaces`, this is exactly `registerCadTools(ctx, scope)`.
 */
export function registerCadToolsWithSurfaces(ctx: any, scope?: SurfaceRegisterScope): readonly string[] {
  const captured = new Map<string, LegacyTool>();
  const toolCtx = Object.create(ctx) as any;
  toolCtx.tools = new Proxy(ctx.tools, {
    get(target: any, prop: string | symbol, receiver: unknown) {
      if (prop === 'register') {
        return (definition: any) => {
          // Buffer registrations until the cutover decision is known. This lets
          // `hideLegacy: 'all'` work without a 39-name hand list.
          captured.set(definition.name, definition as LegacyTool);
          return () => {};
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  registerCadTools(toolCtx, scope);

  const hidden = scope?.hideLegacy === 'all'
    ? new Set(captured.keys())
    : new Set(scope?.hideLegacy ?? []);
  const names = [...captured.keys()].filter((name) => !hidden.has(name));
  for (const [name, definition] of captured) {
    if (!hidden.has(name)) ctx.tools.register(definition);
  }
  const enabled = new Set(scope?.toolSurfaces ?? []);
  const surfaces = [
    enabled.has('session') ? buildCadSessionSurface(captured) : null,
    enabled.has('part') ? buildCadPartSurface(captured) : null,
    enabled.has('assembly') ? buildCadAssemblySurface(captured) : null,
    enabled.has('check') ? buildCadCheckSurface(captured) : null,
    enabled.has('simulate') ? buildCadSimulateSurface(captured) : null,
    enabled.has('inspect') ? buildCadInspectSurface(captured) : null,
    enabled.has('see') ? buildCadSeeSurface(captured) : null,
    enabled.has('python') ? buildCadPythonSurface(captured) : null,
    enabled.has('deliver') ? buildCadDeliverSurface(captured) : null,
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  for (const surface of surfaces) {
    ctx.tools.register(withOutputContract(surface as never) as never);
    names.push(surface.name);
    rememberCadToolName(surface.name);
  }
  return names;
}
