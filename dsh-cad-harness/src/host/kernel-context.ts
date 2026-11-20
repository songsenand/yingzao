// Tell the model which authoring kernel THIS session writes against.
//
// `cad_session info` is pull-only: a model that starts writing before calling it
// has already chosen scadCode vs code. This section is the push half. It is
// registered per agent (not globally) and only for sessions that keep the CAD
// catalog, so a standard coding session pays nothing.
//
// The source of truth is the same one the tools use: the session's project
// marker (`defaultKernel`), else global backend.json (which setup writes). The
// provider is synchronous because the prompt assembler resolves context text
// synchronously; it reads two tiny JSON files, and the project-root cache makes
// the directory walk cheap.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBackendConfig } from './backend.ts';
import { cachedLiveCwd, readSessionBindingRecord, resolveProjectRoot } from './project.ts';
import { decideToolScope, effectivePresetOf, type ToolScopeConfig } from './tool-scope.ts';

export type KernelSource = 'project' | 'global';

export interface EffectiveKernel {
  kernel: 'openscad' | 'cadquery';
  source: KernelSource;
  /** Project root the decision came from (the marker's directory). */
  root: string;
}

/**
 * Resolve the kernel a session should author against, synchronously.
 *
 * Project marker wins over global backend.json; that is the same precedence
 * `cad_session info` reports. A missing/broken marker is not an error here: the
 * global default is the answer, and setup already owns the loud doctor path.
 */
export function effectiveKernelForSession(sessionId: string | null, cwd: string | null): EffectiveKernel {
  let binding: { projectRoot: string } | undefined;
  try { binding = sessionId ? readSessionBindingRecord(sessionId) : undefined; } catch { /* malformed binding: use cwd */ }
  const root = binding?.projectRoot ?? resolveProjectRoot(cwd ?? process.cwd()).root;
  try {
    const marker = JSON.parse(readFileSync(join(root, 'cad-data', 'project.json'), 'utf8')) as { defaultKernel?: unknown };
    if (marker.defaultKernel === 'openscad' || marker.defaultKernel === 'cadquery') {
      return { kernel: marker.defaultKernel, source: 'project', root };
    }
  } catch { /* no marker or unreadable: fall through to global */ }
  try {
    const config = readBackendConfig();
    return { kernel: config.config.kernel, source: 'global', root };
  } catch {
    return { kernel: 'openscad', source: 'global', root };
  }
}

/** The instruction block carried into the system prompt for a CAD session. */
export function kernelPromptText(kernel: EffectiveKernel): string {
  if (kernel.kernel === 'cadquery') {
    return (
      `CAD authoring kernel: cadquery (${kernel.source}). ` +
      'Write CadQuery Python and call generate_part({code}); leave a Workplane/Shape in `result` or call show_object(...). ' +
      'Do not use scadCode in this session; the version source is model.py. ' +
      'Datums use (name, point, direction) point-first. Rendering is STL→OpenSCAD; STEP is optional.'
    );
  }
  return (
    `CAD authoring kernel: openscad (${kernel.source}). ` +
    'Write OpenSCAD source and call generate_part({scadCode}); do not pass CadQuery `code` in this session. ' +
    'BOSL2 (OpenSCAD-only, installed separately) covers gears/threads/fillets via include <BOSL2/...>. ' +
    'The OpenSCAD unit and datum traps apply.'
  );
}

/**
 * Register the per-agent kernel context.
 *
 * Hooks the same creation/switch facts as tool-scope. If the host has no
 * systemPrompt service (headless profiles that omit it), this is a no-op; the
 * tools and `cad_session info` still work.
 */
export function registerKernelPrompt(ctx: any, config: ToolScopeConfig = {}): void {
  const presetIds = config.presets?.length ? [...config.presets] : ['cad'];
  const agents = new Map<string, any>();
  const disposers = new Map<string, () => void>();
  const log = (level: 'info' | 'warn', message: string) => {
    try { ctx.logger?.[level]?.(`cad-harness: ${message}`); } catch { /* logging never breaks a session */ }
  };

  const install = (agent: any, trigger: string) => {
    const sessionId = String(agent?.session?.header?.id ?? '');
    if (!sessionId) return;
    const existing = disposers.get(sessionId);
    if (existing) {
      try { existing(); } catch { /* already disposed */ }
      disposers.delete(sessionId);
    }
    const decision = decideToolScope({
      preset: effectivePresetOf(agent),
      delegationDepth: agent?.session?.header?.delegationDepth,
    }, presetIds);
    if (decision.restrict) return;

    const prompt = agent?.ctx?.systemPrompt ?? agent?.ctx?.reflect?.get?.('systemPrompt');
    if (typeof prompt?.context !== 'function') {
      log('warn', `agent ${sessionId}: no systemPrompt service; kernel is only available via cad_session info`);
      return;
    }
    const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : null;
    try {
      const dispose = prompt.context({
        name: 'cad-kernel',
        // Late but still before the closing environment facts; a context is a
        // user-role snapshot, not a system section, so it cannot be mistaken
        // for policy.
        order: 9500,
        required: true,
        interpolate: false,
        text: () => kernelPromptText(effectiveKernelForSession(sessionId, cachedLiveCwd(sessionId) ?? cwd)),
      });
      disposers.set(sessionId, dispose);
      log('info', `agent ${sessionId}: kernel context installed (${trigger}); ${decision.reason}`);
    } catch (error) {
      log('warn', `agent ${sessionId}: could not install kernel context: ${String((error as Error)?.message ?? error)}`);
    }
  };

  ctx.on('agent/created', (payload: { agent?: any }) => {
    const agent = payload?.agent;
    if (!agent) return;
    const sessionId = String(agent?.session?.header?.id ?? '');
    if (sessionId) agents.set(sessionId, agent);
    install(agent, 'created');
  });

  ctx.on('agent-preset/selected', (sessionId: string) => {
    const agent = agents.get(String(sessionId));
    if (agent) install(agent, 'preset-switch');
  });

  ctx.on('agent/disposed', (payload: { agent?: any }) => {
    const sessionId = String(payload?.agent?.session?.header?.id ?? '');
    if (!sessionId) return;
    const dispose = disposers.get(sessionId);
    if (dispose) {
      try { dispose(); } catch { /* already gone */ }
      disposers.delete(sessionId);
    }
    agents.delete(sessionId);
  });
}
