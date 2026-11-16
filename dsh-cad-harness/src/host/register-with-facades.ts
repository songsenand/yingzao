// Opt-in Phase-2 registration: keep `registerCadTools` unchanged, capture the
// final definitions through a proxy, then add the prototype facade.
//
// Why a wrapper instead of editing tools.ts: tools.ts is under active parallel
// work (physics/measure migration). This module keeps the facade experiment out
// of that file and makes the switch explicit at the plugin entry point.

import { registerCadTools } from './tools.ts';
import { buildCadInspectFacade } from './facade-inspect.ts';
import { buildCadCheckFacade } from './facade-check.ts';
import { buildCadSimulateFacade } from './facade-simulate.ts';
import type { LegacyTool } from './facade.ts';
import { withOutputContract } from './tool-contract.ts';

export interface FacadeRegisterScope {
  toolScope?: string;
  presets?: readonly string[];
  toolFacades?: readonly string[];
  /** Phase 3 cutover probe: do not expose these legacy names. */
  hideLegacy?: readonly string[];
}

/**
 * Register the legacy CAD tools, then optionally the inspect facade.
 *
 * Without `toolFacades`, this is exactly `registerCadTools(ctx, scope)`.
 */
export function registerCadToolsWithFacades(ctx: any, scope?: FacadeRegisterScope): readonly string[] {
  const captured = new Map<string, LegacyTool>();
  const hidden = new Set(scope?.hideLegacy ?? []);
  const toolCtx = Object.create(ctx) as any;
  toolCtx.tools = new Proxy(ctx.tools, {
    get(target: any, prop: string | symbol, receiver: unknown) {
      if (prop === 'register') {
        return (definition: any) => {
          captured.set(definition.name, definition as LegacyTool);
          if (hidden.has(definition.name)) return () => {};
          return target.register(definition);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const names = [...registerCadTools(toolCtx, scope)].filter((name) => !hidden.has(name));
  const enabled = new Set(scope?.toolFacades ?? []);
  const facades = [
    enabled.has('inspect') ? buildCadInspectFacade(captured) : null,
    enabled.has('check') ? buildCadCheckFacade(captured) : null,
    enabled.has('simulate') ? buildCadSimulateFacade(captured) : null,
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  for (const facade of facades) {
    ctx.tools.register(withOutputContract(facade as never) as never);
    names.push(facade.name);
  }
  return names;
}
