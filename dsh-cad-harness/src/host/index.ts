// Host half entry: registers the M0 probe endpoints.
//
// - RPC interceptor on the shared `/api` channel: endpoints prefixed `cad/`
//   are answered here (`cad/echo`).
// - Exact Fetch route serving a generated test STL at `/api/cad/test.stl`.
//
// Injects the `connection` service provided by @deepseek-ai/dsh-client-connection.

import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection';
import { registerCadTools } from './tools.ts';
import { applyProtectedImageOffload } from './image-offload.ts';
import { applyPresetToolScope, type ToolScopeConfig } from './tool-scope.ts';
import { configurePythonRuntime, ensurePythonRuntime, pythonRuntimeMode, recordRuntimeFailure } from './python-runtime.ts';
import { resetPythonWorker } from './python-worker.ts';

export const name = 'cad-harness';

// `connection` is optional: the headless profile has no web server, so the
// client-facing routes only register when the service exists.
export const inject = ['tools', 'attachments'];

/** Generate a minimal binary STL of a 20mm cube centred at origin. */
function cubeBinaryStl(size = 20): Uint8Array {
  const tris: number[][][] = [];
  const s = size / 2;
  // 12 triangles of a cube: [normal, v1, v2, v3]
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    tris.push([n, a, b, c], [n, a, c, d]);
  };
  quad([-s,-s,-s],[ s,-s,-s],[ s, s,-s],[-s, s,-s],[0,0,-1]); // -z
  quad([-s,-s, s],[ s,-s, s],[ s, s, s],[-s, s, s],[0,0, 1]); // +z
  quad([-s,-s,-s],[-s,-s, s],[-s, s, s],[-s, s,-s],[-1,0,0]); // -x
  quad([ s,-s,-s],[ s, s,-s],[ s, s, s],[ s,-s, s],[1,0, 0]); // +x
  quad([-s,-s,-s],[ s,-s,-s],[ s,-s, s],[-s,-s, s],[0,-1,0]); // -y
  quad([-s, s, s],[ s, s, s],[ s, s,-s],[-s, s,-s],[0, 1,0]); // +y

  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  const header = new TextEncoder().encode('dsh-cad-harness M0 test cube'.padEnd(80, ' '));
  new Uint8Array(buf).set(header.subarray(0, 80), 0);
  view.setUint32(80, tris.length, true);
  let off = 84;
  for (const [n, a, b, c] of tris) {
    for (const v of [n, a, b, c]) {
      view.setFloat32(off, v[0], true);
      view.setFloat32(off + 4, v[1], true);
      view.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    view.setUint16(off, 0, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

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

  ctx.effect(() => {
    const stl = cubeBinaryStl();

    // Exact Fetch route below /api: serves the test STL to the browser.
    // Path must include the /api channel prefix (enforced by assertFetchRoute).
    const disposeFetch = connection.fetch.register({
      path: '/api/cad/test.stl',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => new Response(stl as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'model/stl' },
      }),
    });

    // Intercept `cad/*` endpoints on the shared /api RPC channel.
    const disposeRpc = connection.rpc.intercept(
      '/api',
      (endpoint: string) => endpoint.startsWith('cad/'),
      async (endpoint: string, payload: any): Promise<ConnectionRpcResult<unknown>> => {
        if (endpoint === 'cad/echo') {
          return {
            ok: true,
            value: {
              pong: true,
              receivedAt: new Date().toISOString(),
              echo: payload?.message ?? null,
            },
          };
        }
        return {
          ok: false,
          error: { code: 'UNKNOWN_ENDPOINT', message: `no such cad endpoint: ${endpoint}`, details: {} },
        };
      },
    );

    return async () => {
      await disposeFetch();
      await disposeRpc();
    };
  }, 'cad-harness: probe endpoints');
}
