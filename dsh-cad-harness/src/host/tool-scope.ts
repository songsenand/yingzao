// Keep the CAD tool catalog out of sessions that did not ask for it.
//
// Why this exists: this bundle mounts on the PROFILE plane, so its tools land
// in the process-global registry and every agent inherits them — including a
// pure coding session, which then pays for eleven CAD schemas it will never
// call. Measured from this workspace's own durable request headers: a clean
// catalog is 27 tools ~= 6,833 token; with the CAD catalog it is 38 tools
// ~= 11,449 token. That +4,616 is paid on EVERY request.
//
// The harness already draws the line we need: model-facing tools belong on the
// AGENT plane (a preset composition), and a preset is what a session names.
// `ctx.tools.restrict()` is the per-agent visibility filter over global tools
// ("Restrictions intersect; scoped registrations remain visible"). So: register
// globally as before, then REMOVE the CAD catalog from every agent whose
// session did not name a CAD preset.
//
// WHICH PRESET: the EFFECTIVE one, never the creation header.
//
// This is the bug that cost a real run. `session.header.agentPreset` is a
// creation fact and is deep-frozen, so a session that started as 标准模式 and
// then switched to 造物模式 (allowed while blank) still reads "standard" in its
// header forever. Reading the header therefore hid the CAD tools from a session
// that had correctly selected the CAD preset — the switch succeeded, the log
// recorded it, and the model still received 27 tools with zero CAD ones.
// `dsh-agent-presets` states the rule in its own module doc: "Reconstruction
// reads the `agentPreset` Session projection, never the header alone". So the
// projection is the source, the header only a fallback. A live switch is
// honoured too: `ctx.tools.restrict()` returns the disposer that lifts the
// filter, and `agent-preset/selected` is where that disposer gets called.
//
// ADOPTION COST, stated where the next reader will see it: restricting is only
// half the story — switching this on strips the CAD tools from every session
// that already exists (a restriction applied at creation cannot help a session
// that was already running). Install it when the CAD work starts fresh — a new
// project pays nothing — never in the middle of one.
//
// Two further decisions worth stating:
//   * A session with NO preset keeps the tools. Deployments that do not compose
//     per session (headless runs, older profiles) must not silently lose the
//     capability they were built for.
//   * A delegated child (delegationDepth > 0) also keeps them: a subagent
//     spawned by a CAD session is doing CAD work, and its own header may name
//     the parent's or a default preset rather than a CAD one.
//
// The routes, the usage telemetry and the browser panel stay global, so the
// human keeps every channel (look / measure / annotate / screenshot / export)
// in any session; only the agent's tool access narrows.

/** How the plugin decides which sessions may call the CAD tools. */
import { toolsInGroups } from './tool-groups.ts';

/**
 * The job groups a session can declare (DESIGN §25.7). Declared here because
 * tool-scope is the module that consumes them; tool-groups owns the roster.
 */
export type CadToolGroup = 'deliver' | 'detect' | 'simulate' | 'instrument';

export interface ToolScopeConfig {
  /**
   * `'global'` (default) leaves the plain behaviour: every session may call the
   * CAD tools. `'preset'` hides them from sessions that did not name one of
   * {@link presets}.
   */
  toolScope?: 'global' | 'preset';
  /** Preset ids that keep the CAD tools when `toolScope` is `'preset'`. */
  presets?: readonly string[];
  /**
   * How the bundled Python runtime is provisioned (DECISION-LOG 2026-10-08).
   * `'auto'` (default) health-checks at startup and installs on first use;
   * `'eager'` starts the one-time install in the background at startup;
   * `'off'` disables it; `'system'` uses a system CPython 3.10+ instead.
   * `DSH_CAD_PYTHON` overrides this value.
   */
  pythonRuntime?: 'auto' | 'eager' | 'off' | 'system';
  /** Declaration source ①: job groups for ALL CAD sessions. Absent = whole catalog. */
  groups?: readonly CadToolGroup[];
  /** Declaration source ② (the useful one): preset id → the groups THAT preset works in.
   *  Per-session by construction — a session that switches preset switches its roster. */
  presetGroups?: Record<string, readonly CadToolGroup[]>;
}

/** What the scope decided for one agent, for logging and for the acceptance test. */
export interface ScopeDecision {
  restrict: boolean;
  reason: string;
  preset: string | null;
}

/**
 * Decide one agent's visibility.
 *
 * Pure so the acceptance script can check the rule without a live runtime.
 *
 * @param session - the preset the session EFFECTIVELY runs plus its delegation
 *   depth. Deliberately not the session header: the header is a creation fact
 *   and a switched session keeps its birth value there (see the file header).
 * @param presetIds - preset ids that keep the tools.
 * @returns whether to restrict, why, and the preset that was read.
 */
export function decideToolScope(
  session: { preset: string | null; delegationDepth?: number },
  presetIds: readonly string[],
): ScopeDecision {
  const preset = session?.preset ?? null;
  if (preset === null) {
    return { restrict: false, reason: 'session names no preset — leaving the catalog unchanged', preset };
  }
  if (presetIds.includes(preset)) {
    return { restrict: false, reason: `preset "${preset}" is a CAD preset`, preset };
  }
  if ((session?.delegationDepth ?? 0) > 0) {
    return { restrict: false, reason: 'delegated child — inherits its parent task', preset };
  }
  return { restrict: true, reason: `preset "${preset}" is not a CAD preset`, preset };
}

/**
 * The preset a live session actually runs.
 *
 * The `agentPreset` session projection is authoritative — it starts from the
 * header and advances on every `agent-preset/selected` event — but the service
 * may be absent (a profile without dsh-agent-presets), so the header is the
 * fallback. Reading the projection is what makes a post-creation switch work.
 *
 * @param agent - the agent whose session is being scoped.
 * @returns the preset id, or null when the session names none.
 */
export function effectivePresetOf(agent: any): string | null {
  try {
    const read = agent?.ctx?.sessionProjections?.stateOf;
    if (typeof read === 'function') {
      const value = read.call(agent.ctx.sessionProjections, agent.session, 'agentPreset');
      if (typeof value === 'string' && value) return value;
      if (value === null) return null;
    }
  } catch { /* projection unavailable or not yet registered — fall through */ }
  const header = agent?.session?.header?.agentPreset;
  return typeof header === 'string' && header ? header : null;
}

/**
 * Wire the preset tool scope.
 *
 * Applied on `agent/created`, before the agent's first request, and registered
 * through the agent's own context so the restriction lives and dies with that
 * agent (the registry appends it as a scope effect). A restriction that names
 * an unknown global tool throws, so any failure here is logged and contained:
 * the worst case is a session that keeps tools it did not need, never a broken
 * agent.
 *
 * @param ctx - host plugin context.
 * @param toolNames - the CAD tool names to hide.
 * @param config - plugin config.
 */
export function applyPresetToolScope(ctx: any, toolNames: readonly string[], config: ToolScopeConfig): void {
  // Declared groups narrow THIS session's catalog; no declaration keeps it whole.
  const declared = toolsInGroups(config.groups);
  const names = declared ? toolNames.filter((n) => declared.includes(n)) : toolNames;
  const presetIds = config.presets?.length ? [...config.presets] : ['cad'];
  /** session id → the live agent (needed to re-decide when its preset changes). */
  const agents = new Map<string, any>();
  /** session id → the disposer that lifts that agent's restriction. */
  const denials = new Map<string, () => void>();
  const log = (level: 'info' | 'warn', message: string) => {
    try {
      ctx.logger?.[level]?.(`cad-harness: ${message}`);
    } catch { /* logging must never break agent creation */ }
  };

  log('info', `tool scope: preset ${presetIds.join('/')} keeps ${names.length} CAD tools; every other named preset hides them`);

  /** Re-decide one agent and move it into the decided state (idempotent). */
  /** The roster for THIS session: its preset's groups if declared, else the global set. */
  const namesForPreset = (preset: string | null): readonly string[] => {
    const declared = toolsInGroups((preset ? config.presetGroups?.[preset] : undefined) ?? config.groups);
    return declared ? toolNames.filter((n) => declared.includes(n)) : toolNames;
  };

  const apply = (agent: any, trigger: string) => {
    const sessionId = String(agent?.session?.header?.id ?? '');
    const label = `agent${sessionId ? ` ${sessionId}` : ''}`;
    const decision = decideToolScope({
      preset: effectivePresetOf(agent),
      delegationDepth: agent?.session?.header?.delegationDepth,
    }, presetIds);
    const lifted = () => {
      const lift = denials.get(sessionId);
      if (!lift) return;
      denials.delete(sessionId);
      try { lift(); } catch { /* already gone */ }
    };
    if (!decision.restrict) {
      if (denials.has(sessionId)) {
        lifted();
        log('info', `${label}: CAD tools restored — ${decision.reason} (${trigger})`);
      } else {
        log('info', `${label}: keeping CAD tools — ${decision.reason}`);
      }
      return;
    }
    if (denials.has(sessionId)) return; // already hidden
    // Per-session: a preset that declares its groups sees only those tools.
    const names = namesForPreset(decision.preset ?? null);
    try {
      const agentCtx = agent?.ctx;
      if (typeof agentCtx?.tools?.restrict !== 'function') {
        log('warn', `${label}: no agent-scoped tools service; CAD tools stay visible`);
        return;
      }
      denials.set(sessionId, agentCtx.tools.restrict({ deny: [...names] }));
      log('info', `${label}: hid ${names.length} CAD tools — ${decision.reason} (${trigger})`);
    } catch (e) {
      log('warn', `could not hide the CAD tools (${String((e as Error)?.message ?? e)}); they stay visible`);
    }
  };

  ctx.on('agent/created', (payload: { agent?: any }) => {
    const agent = payload?.agent;
    const sessionId = String(agent?.session?.header?.id ?? '');
    if (sessionId) agents.set(sessionId, agent);
    apply(agent, 'created');
  });

  // A session may still change preset while blank, and the change outlives the
  // blank window ("the first turn — and every turn after it — runs under the
  // newly mounted composition"). Without this the restriction taken at creation
  // would contradict the preset the session actually runs.
  ctx.on('agent-preset/selected', (sessionId: string, preset: string) => {
    const agent = agents.get(String(sessionId));
    if (!agent) return;
    log('info', `agent ${sessionId}: preset switched to "${preset}"`);
    apply(agent, 'switch');
  });
}
