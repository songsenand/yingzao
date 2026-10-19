// Which CAD corpus the browser is looking at.
//
// The plugin keeps ONE CORPUS PER PROJECT (`$DSH_HOME/cad/<project>`, see
// src/host/project.ts), so a request that addresses a version or a run
// (`?v=v001`, `?id=r001`) is ambiguous until it also names its project — every
// project numbers its own versions from `v001`. The project key is the session's
// working directory, read from the session list rather than cached at mount:
// the CAD tab is a single sidebar tab shared by every session, so switching
// sessions must switch the corpus.
//
// This lives in its own module so the panel and the playback views can both
// build URLs without importing each other.

let sessionsService: any = null;

/** Wire the sessions service (called once from the client entry). */
export function setProjectServices(opts: { sessions?: any }): void {
  if (opts.sessions) sessionsService = opts.sessions;
}

let cwd = '';

/**
 * A corpus the human pinned in the panel's workspace dropdown, or null.
 *
 * Deliberately separate from `cwd`: `cwd` stays the session fact (what the
 * agent's tools write to), while `override` is only the VIEW target. Switching
 * the dropdown therefore never changes where new versions land — the panel is
 * read-only, and "look at one corpus, write to another" must not be possible.
 */
let override: string | null = null;

/** The project currently on stage ('' until the session list resolves). */
export function currentProject(): string {
  return override ?? cwd;
}

/** The session's own working directory, ignoring any pinned view override. */
export function sessionCwd(): string {
  return cwd;
}

/**
 * Pin the panel to another corpus (read-only browse); null follows the session.
 *
 * A session switch calls this with null (see `refreshProjectScope`): the pin
 * means "this corpus", never "this corpus in any project".
 */
export function setProjectOverride(dir: string | null): void {
  override = dir && dir.trim() ? dir : null;
}

/** The pinned view corpus, or null when following the session. */
export function projectOverride(): string | null {
  return override;
}

/**
 * The id of the session shown in the main view, or '' when it cannot be told.
 *
 * The list snapshot has NO `current` field (the pre-upgrade shape had one; the
 * 2026-10-03 dsh upgrade removed it and silently broke per-project scoping —
 * every panel fell back to the host's own cwd). The shipped preset picker
 * (dsh-client-ui-agent-preset) determines "on stage" structurally instead:
 * a session is current when the sessions service has a LIVE BINDING for it
 * (`sessions.binding(id)`) AND the main view retains it
 * (`retainInfo(id).retainedBy.mainView > 0`). Mirror exactly that.
 */
export function currentSessionId(): string {
  try {
    const state = sessionsList();
    if (!state?.byId) return '';
    for (const id of Object.keys(state.byId)) {
      try {
        if (sessionsService?.binding?.(id) === undefined) continue;
        const retained = sessionsService?.retainInfo?.(id)?.getSnapshot?.()?.retainedBy;
        if ((retained?.mainView ?? 0) > 0) return id;
      } catch { /* not the active one */ }
    }
  } catch { /* fall through */ }
  return '';
}

/**
 * The cwd of the session on stage, or '' when it cannot be told.
 *
 * Legacy fallback first: an older dsh exposed `state.current` directly, so
 * deployments on that shape keep working. Otherwise resolve structurally (see
 * `currentSessionId`).
 */
export function currentSessionCwd(): string {
  try {
    const state = sessionsList();
    const id = state?.current ?? currentSessionId();
    const value = id ? state?.byId?.[id]?.cwd : '';
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * Read the sessions list snapshot.
 *
 * The store is a uSES `SnapshotStore`: its reader is **`getSnapshot()`**, and
 * that is what every shipped client plugin uses (`sessions.list.getSnapshot()`
 * — 21 call sites in this install, e.g. the shipped chat plugin reading
 * `...byId[sessionId]?.cwd`). It exposes no `.get()` and no `.value`, so the
 * obvious-looking `list.get?.() ?? list.value` silently yields `undefined` for
 * ever after — which is exactly how this panel managed to show an empty part
 * list in every session: no cwd → no `?project=` → the host fell back to its own
 * working directory. The alternative readers stay as fallbacks for other store
 * shapes, but `getSnapshot` is the real one.
 */
function sessionsList(): any {
  return sessionsService?.list?.getSnapshot?.()
    ?? sessionsService?.list?.get?.()
    ?? sessionsService?.list?.value;
}

/**
 * The preset the session on stage was created with, or null when unknown.
 *
 * Read from the `agentPreset` session projection — the same source the shipped
 * preset picker reads. Null (rather than a guess) for sessions that predate
 * presets, so callers stay silent instead of warning wrongly.
 */
export function currentSessionPreset(): string | null {
  try {
    const state = sessionsList();
    const id = state?.current ?? currentSessionId();
    const value = id ? state?.byId?.[id]?.projectionValues?.agentPreset : undefined;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether the session on stage still has an empty log, or null when unknown.
 *
 * This decides whether a lost preset choice is still recoverable: the host only
 * refuses a preset switch once a turn has started
 * (`swap()` → `agent-preset/locked` when `lastTurn > 0`), so a BLANK session can
 * still be switched, while a started one cannot.
 */
export function currentSessionBlank(): boolean | null {
  try {
    const state = sessionsList();
    const id = state?.current ?? currentSessionId();
    const value = id ? state?.byId?.[id]?.blank : undefined;
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

/** The host's tool-scope decision, as reported by `GET /api/cad/scope`. */
export interface CadScope {
  toolScope: 'global' | 'preset';
  presets: string[];
  /** Preset id → display name, when the host could resolve the roster. */
  names?: Record<string, string>;
}

/**
 * Whether the session on stage can actually reach the CAD tools.
 *
 * WHY THE PANEL ASKS. The human's side of this plugin is global (routes, tab,
 * telemetry) while the model's side is preset-scoped, so the two can disagree:
 * a 标准模式 session shows a perfectly normal CAD panel and an empty part list,
 * while the agent has no CAD tools at all — and the only symptom is the agent
 * behaving strangely (observed for real: the model read the CAD skill file
 * through bash after `skill "cad-toolbox" is unknown`, because the skill root is
 * mounted by the same preset). The panel is the human's channel, so it has to
 * say which of the two situations they are in.
 *
 * Mirror of the host rule in `src/host/tool-scope.ts`, minus the delegation
 * case: a subagent keeps the tools, but a subagent is never what the panel is
 * looking at.
 *
 * @param scope - host tool-scope config; null while it is still being fetched.
 * @param preset - the session's preset id; null when unknown.
 * @returns true when the panel should NOT warn.
 */
export function cadToolsVisible(scope: CadScope | null, preset: string | null): boolean {
  if (!scope || scope.toolScope !== 'preset') return true; // global scope: every session has them
  if (!preset) return true;                                // unknown preset: do not guess
  return scope.presets.includes(preset);
}

/**
 * The banner the panel shows when this session has no CAD tools, or null.
 *
 * The two branches are NOT cosmetic — they are the two different physical
 * situations, and only one of them is still fixable:
 *
 *   * blank session  → the host still accepts a switch (`lastTurn === 0`), so
 *     re-picking the preset at the chip works. Say so, and say it now.
 *   * started session → the preset is locked for good; the only ways out are a
 *     new session or making the CAD preset the deployment default.
 *
 * This wording is not hypothetical. A real run was lost to the silent path: the
 * preset chip is STAGED in the browser (`stage()` paints the chip with your
 * pick) and is discarded without a word when the session it lands on is no
 * longer blank — the pick looks accepted, the session is born 标准模式, and the
 * agent then fails in ways that look like plugin bugs (`skill "cad-toolbox" is
 * unknown`). The panel is the human's channel, so it names the situation and the
 * way out instead of implying the choice was never made.
 *
 * @param scope - host tool-scope config; null while it is still being fetched.
 * @param preset - the session's preset id; null when unknown.
 * @param blank - whether the session still has an empty log; null when unknown.
 * @returns the notice text, or null when there is nothing to warn about.
 */
export function cadMissingToolsNotice(
  scope: CadScope | null,
  preset: string | null,
  blank: boolean | null,
): string | null {
  // `!preset` is implied by cadToolsVisible, but stated so the type narrows.
  if (!preset || cadToolsVisible(scope, preset)) return null;
  const label = (id: string) => scope?.names?.[id] ?? id;
  const wanted = (scope?.presets ?? []).map(label).join(' / ') || 'CAD';
  if (blank === true) {
    return `预设没生效：本会话是「${label(preset)}」 · 会话还没开始，现在重新选一次「${wanted}」还能生效`;
  }
  if (blank === false) {
    return `预设没生效：本会话以「${label(preset)}」开始，已锁定 · 新建会话，或在设置里把「${wanted}」设为默认预设`;
  }
  return `此会话没有 CAD 工具（预设「${label(preset)}」不在开放列表里） · 新建会话并选「${wanted}」`;
}

/**
 * Re-read the project from the session list.
 * @returns the project now on stage and whether it changed since last call.
 */
export function refreshProjectScope(): { cwd: string; switched: boolean } {
  const next = currentSessionCwd();
  const switched = next !== cwd;
  cwd = next;
  // A pinned corpus belongs to the old session's tree: following the new
  // session is the only safe interpretation of a switch.
  if (switched) override = null;
  return { cwd: next, switched };
}

/** Append the project to a `/api/cad/...` URL. The one way to build one. */
export function withProject(url: string): string {
  const target = currentProject();
  if (!target) return url;
  return `${url}${url.includes('?') ? '&' : '?'}project=${encodeURIComponent(target)}`;
}
