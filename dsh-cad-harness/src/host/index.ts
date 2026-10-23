// Host half entry: registers the CAD tools (in tools.ts, together with the browser
// routes they serve) and the runtime hooks around them.
//
// The M0 probe endpoints (`cad/echo`, `/api/cad/test.stl`) were removed on 2026-10-23:
// nothing had called them since the panel moved to the real routes, and an unreferenced
// RPC interceptor is a debugging surface nobody is watching (audit FIX-E1).

import { registerCadTools } from './tools.ts';
import { applyProtectedImageOffload } from './image-offload.ts';
import { applyPresetToolScope, type ToolScopeConfig } from './tool-scope.ts';
import { configurePythonRuntime, ensurePythonRuntime, pythonRuntimeMode, recordRuntimeFailure } from './python-runtime.ts';
import { resetPythonWorker } from './python-worker.ts';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'cad-harness';

// `connection` is optional: the headless profile has no web server, so the
// client-facing routes only register when the service exists.
export const inject = ['tools', 'attachments'];

/**
 * Say it out loud when the CAD skills would be invisible.
 *
 * `presets/cad/preset.patch.yml` is generated, and its `customSkillDirs` entry is an
 * ABSOLUTE path — correct on the machine that ran `scripts/sync-cad-preset.mjs`, wrong
 * after a clone or a move. A wrong path there fails silently: the session gets the CAD
 * tools but no CAD skill, which is the "零打扰 ≠ 零提示" case (HARNESS §11.7) — the
 * capability is missing and nothing says so. This warns with the fix command instead.
 */
function warnIfSkillRootIsStale(ctx: any): void {
  try {
    const here = realpathSync(join(new URL('../../skills', import.meta.url).pathname));
    const presetPath = join(new URL('../../presets/cad/preset.patch.yml', import.meta.url).pathname);
    if (!existsSync(presetPath)) return;
    const match = /customSkillDirs:\s*\n\s*-\s*(\S+)/.exec(readFileSync(presetPath, 'utf8'));
    const configured = match?.[1];
    if (!configured || !existsSync(configured) || realpathSync(configured) !== here) {
      ctx.logger?.warn?.(
        `cad-harness: the CAD preset's skill root (${configured ?? '(none)'}) does not point at this ` +
        `checkout (${here}) — CAD sessions will get the tools but NOT the skill. ` +
        'Fix: node scripts/sync-cad-preset.mjs',
      );
    }
  } catch { /* a warning must never break activation */ }
}

export function apply(ctx: any, config: ToolScopeConfig = {}) {
  const cadTools = registerCadTools(ctx, config);
  warnIfSkillRootIsStale(ctx);

  // The bundled Python runtime (DECISION-LOG 2026-10-08). The mode comes from
  // the profile patch and is overridden by DSH_CAD_PYTHON. Default 'auto' costs
  // nothing at startup and installs on the first run_python call; 'eager' is the
  // opt-in for deployments that would rather pay the one-time download now than
  // during a session. Nothing here blocks plugin activation.
  configurePythonRuntime({ mode: config?.pythonRuntime });
  if (pythonRuntimeMode() === 'eager') {
    void ensurePythonRuntime({ onProgress: (message) => ctx.logger?.info?.(`cad-harness: python runtime: ${message}`) })
      .catch((error) => recordRuntimeFailure(error, { onProgress: (message) => ctx.logger?.warn?.(`cad-harness: ${message}`) }));
  }

  // The resident worker is a CHILD PROCESS, so it has to be stopped on unload:
  // otherwise a disposed harness leaves a Python interpreter holding the event
  // loop (measured — an un-stopped worker keeps even a plain script alive
  // forever). Registered before the web-only block below so headless runs get it
  // too.
  ctx.effect(() => () => resetPythonWorker());

  // Keep the CAD catalog out of sessions that did not ask for it (see
  // tool-scope.ts for the measurement and for the adoption cost).
  if (config?.toolScope === 'preset') applyPresetToolScope(ctx, cadTools, config);

  // Image policy (DESIGN §16–17): NO route-level budget is applied —
  // standard-mode sessions run on dsh factory defaults. The 造物 preset's
  // 24-image window is enforced per session by the preset-aware offload
  // executor, which also replaces the stock executor (cordis.patch.yml).
  applyProtectedImageOffload(ctx);

  // Browser-facing routes only when a web connection exists (headless has none).
  // reflect.get() reads the service without the inject requirement.
  const connection = ctx.reflect.get('connection');
  if (!connection) return;

}
