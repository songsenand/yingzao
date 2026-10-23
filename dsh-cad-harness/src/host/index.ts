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

export const name = 'cad-harness';

// `connection` is optional: the headless profile has no web server, so the
// client-facing routes only register when the service exists.
export const inject = ['tools', 'attachments'];

export function apply(ctx: any, config: ToolScopeConfig = {}) {
  const cadTools = registerCadTools(ctx, config);

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
