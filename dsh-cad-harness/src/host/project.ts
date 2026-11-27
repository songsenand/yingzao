// Project scope: which CAD corpus a call is allowed to see.
//
// WHY THIS EXISTS. Every store used to be opened once, at plugin apply, from
// `ctxRevisionRoot()` — the plugin's own installation directory. That made the
// plugin a single global corpus: a brand-new project opened the CAD panel and
// listed the previous project's parts, and worse, `ensurePart()` matches parts
// by NAME, so a new project's "底座" silently adopted the old project's 底座 and
// the two revision histories were stitched together. Version/run ids are also
// per-corpus (`v001`, `r001`), so a flat namespace cannot even address two
// projects: `/api/cad/run?id=r001` is ambiguous.
//
// So a corpus is addressed, never assumed:
//
//   project = the calling session's working directory (`session.header.cwd`)
//   data    = $DSH_HOME/cad/<label>-<hash8>/     (one directory per project)
//
// `cwd` is the right key because it is already the durable creation fact the
// rest of the harness groups by (session logs live under
// `$DSH_HOME/sessions/<encoded-cwd>/`), and because "same directory = same
// project" is what a human means by a project: two sessions in one directory
// share their parts, a new directory starts empty.
//
// Everything here is pure path arithmetic plus one write (`ensureProjectDir`);
// callers decide when a directory may be created. Reads must NOT create it — a
// project with no data yet reads as empty, which is the whole point.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { openPartStore, type PartStore } from './parts.ts';
import { writeJsonAtomic } from './file-lock.ts';
import { openRunStore, type RunStore } from './runs.ts';
import { openVersionStore, type VersionStore } from './version.ts';

/** `$DSH_HOME`, or `~/.dsh` — the same root session logs and attachments live under. */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : join(homedir(), '.dsh');
}

/** Profile-level siblings live here; `telemetry` is the one resident (DESIGN §19). */
export function projectsHome(): string {
  return join(dshHome(), 'cad');
}

/**
 * The calling session's id from a tool `exec`, or undefined when there is none.
 *
 * One reader for every consumer: project binding, write provenance and the
 * model-side tool wrapper must agree on what "the same conversation" means.
 * HTTP routes have no `exec`; maintenance scripts deliberately have no session.
 */
export function sessionIdOf(exec: unknown): string | undefined {
  const raw = (exec as { agent?: { session?: { header?: { id?: unknown } } } })?.agent?.session?.header?.id;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * Per-project data lives INSIDE the project: `<cwd>/cad-data/` (DESIGN §19).
 *
 * The 2026-10-03 user decision: artifacts belong to the project folder, so
 * deleting the folder deletes the corpus and recreating a same-named project
 * in place starts fresh — no hash-directory archaeology, nothing to look up
 * under $DSH_HOME. Route/telemetry data stays profile-level (above).
 */
export function projectDataDir(cwd: string): string {
  return join(resolve(cwd), 'cad-data');
}

/** How a project root was recognized (see docs/dev/PROJECT-SCOPE.md). */
export type ProjectRootMarker = 'project' | 'legacy' | 'workspace' | 'new';

/** The nearest project root for one working directory. */
export interface ResolvedProjectRoot {
  root: string;
  marker: ProjectRootMarker;
}

const projectRootCache = new Map<string, ResolvedProjectRoot>();

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function markerAt(dir: string): ProjectRootMarker | null {
  const cadData = join(dir, 'cad-data');
  if (isDirectory(cadData)) {
    return existsSync(join(cadData, 'project.json')) ? 'project' : 'legacy';
  }
  // A workspace is a CONTAINER: it holds projects but is never a write target.
  // It is a separate sentinel so `cad-data/` (and its absence) keeps its old
  // meaning and the legacy migration path is unchanged.
  if (existsSync(join(dir, 'cad-workspace.json'))) return 'workspace';
  return null;
}

/**
 * Find the project root that owns `start`.
 *
 * B (`docs/dev/PROJECT-SCOPE.md`): the nearest ancestor with
 * `cad-data/project.json` is the project; a bare `cad-data/` is a legacy
 * marker; with neither, `start` itself is a new project candidate (the first
 * WRITE creates the marker). Realpath first so a symlinked working directory
 * resolves to one identity. Cached by canonical start; a newly written marker
 * clears the cache.
 */
export function resolveProjectRoot(start: string): ResolvedProjectRoot {
  let canonical: string;
  try {
    canonical = realpathSync(start);
  } catch {
    canonical = resolve(start);
  }
  try {
    if (!statSync(canonical).isDirectory()) canonical = dirname(canonical);
  } catch { /* keep the unresolved path; the walk below still works */ }

  const hit = projectRootCache.get(canonical);
  if (hit) return hit;

  let dir = canonical;
  while (true) {
    const marker = markerAt(dir);
    if (marker !== null) {
      const result: ResolvedProjectRoot = { root: dir, marker };
      projectRootCache.set(canonical, result);
      return result;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const result: ResolvedProjectRoot = { root: canonical, marker: 'new' };
  projectRootCache.set(canonical, result);
  return result;
}

/** Test/ensure hook: a newly written marker invalidates earlier "new" answers. */
export function clearProjectRootCache(): void {
  projectRootCache.clear();
}

// --- C-lite: one project per session, bound on the first CAD call ------------

const sessionBindingCache = new Map<string, string>();

function safeSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'session';
}

/** `$DSH_HOME/cad/sessions/` — plugin-owned, one JSON per session. */
export function sessionBindingsDir(): string {
  return join(projectsHome(), 'sessions');
}

/** The binding file for one session id. */
export function sessionBindingPath(sessionId: string): string {
  return join(sessionBindingsDir(), `${safeSessionId(sessionId)}.json`);
}

export function readSessionBindingRecord(sessionId: string): { projectRoot: string; boundAt?: string } | undefined {
  const cached = sessionBindingCache.get(sessionId);
  if (cached && isDirectory(cached)) return { projectRoot: cached };
  if (cached) sessionBindingCache.delete(sessionId);
  try {
    const parsed = JSON.parse(readFileSync(sessionBindingPath(sessionId), 'utf8'));
    const root = parsed?.projectRoot;
    if (typeof root === 'string' && root.trim() && isDirectory(root)) {
      sessionBindingCache.set(sessionId, root);
      return {
        projectRoot: root,
        ...(typeof parsed?.boundAt === 'string' ? { boundAt: parsed.boundAt } : {}),
      };
    }
  } catch { /* no binding yet, or unreadable: fall back to the resolver */ }
  return undefined;
}

function readSessionBinding(sessionId: string): string | undefined {
  return readSessionBindingRecord(sessionId)?.projectRoot;
}

function writeSessionBinding(sessionId: string, root: string): void {
  sessionBindingCache.set(sessionId, root);
  try {
    mkdirSync(sessionBindingsDir(), { recursive: true });
    const target = sessionBindingPath(sessionId);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({
      schemaVersion: 1,
      sessionId,
      projectRoot: root,
      boundAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    renameSync(tmp, target);
  } catch { /* the in-process cache still keeps the session bound */ }
}

/** Test hook: forget in-process bindings (files stay on disk). */
export function clearSessionBindingCache(): void {
  sessionBindingCache.clear();
}

/**
 * Profile-wide telemetry (token/image accounting), deliberately NOT per
 * project: `registerUsageObserver` observes every session's `llm/stream` at
 * once, and the numbers it reports are about the request, not the design.
 */
export function telemetryRoot(): string {
  return join(projectsHome(), 'telemetry');
}

/**
 * Directory name for one project: `<basename>-<hash8>`.
 *
 * The hash is over the resolved path, so it separates same-named projects
 * (`~/a/microscope` vs `~/b/microscope`) and survives a basename that is empty
 * or full of separators. Readability is a convenience only — `project.json`
 * inside the directory is the authoritative record of which cwd it belongs to.
 */
export function projectKey(cwd: string): string {
  const canonical = resolve(cwd);
  const label = (basename(canonical) || 'project')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40) || 'project';
  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 8);
  return `${label}-${hash}`;
}

/** The three stores of one project, all rooted at the same directory. */
export interface ProjectStores {
  /** Resolved project directory (the session cwd this corpus belongs to). */
  cwd: string;
  /** `.../cad/<key>/` — the version store root. */
  root: string;
  store: VersionStore;
  runStore: RunStore;
  partStore: PartStore;
}

// One ProjectStores per distinct cwd: the objects are plain `{root}` carriers,
// so a shared instance is safe, and every call site stops re-deriving paths.
const cache = new Map<string, ProjectStores>();

/** Stores for a project. Pure: never touches the filesystem. */
export function projectStores(cwd: string): ProjectStores {
  const canonical = resolve(cwd);
  const hit = cache.get(canonical);
  if (hit) return hit;
  const root = projectDataDir(canonical);
  const built: ProjectStores = {
    cwd: canonical,
    root,
    store: openVersionStore(root),
    runStore: openRunStore(root),
    partStore: openPartStore(root),
  };
  cache.set(canonical, built);
  return built;
}

/**
 * The project a tool call belongs to: the calling agent's session cwd.
 *
 * B (`docs/dev/PROJECT-SCOPE.md`): the project is the nearest ancestor with
 * `cad-data/project.json` (or legacy `cad-data/`). The agent's current working
 * directory is only the starting point; a `cd` inside the project stays on it,
 * a `cd` to a sibling with its own marker switches, and a directory with no
 * marker is a new project candidate. The session header is the fallback when no
 * workingDirectory service is present. There is no delegationDepth special case:
 * a subagent's `cwd` is its working directory, and the resolver handles it.
 *
 * C-lite: after the first CAD call, the session is bound to that root in
 * `$DSH_HOME/cad/sessions/<id>.json`; later `cd` calls do not switch. A session
 * with no id keeps the pure B behavior (the resolver follows the working
 * directory), which is what maintenance callers and tests use.
 *
 * A call with no agent (a maintenance caller, a script) falls back to the
 * server's own cwd, which is the workspace the profile was started in.
 *
 * G5 (2026-10-29): the live cwd comes from the workingDirectory SERVICE — the
 * same one the stock bash tool uses (`ctx.workingDirectory.ensure(agent, signal)`
 * via the plugin `inject` array). Until this fix the code guessed an
 * `agent.ctx.get('workingDirectory')` shape that exists on no real exec, so the
 * lookup silently fell back to the session-header cwd — and C-lite then bound
 * the WRONG root forever (roberval-balance: the corpus was generated at the repo
 * root and had to be moved by hand). The acceptance that covered the old shape
 * was measuring its own stub.
 */

/** The DSH workingDirectory service, injected at plugin activation (may be absent). */
let workingDirectoryService: { ensure?: (agent: unknown, signal?: unknown) => Promise<unknown> } | undefined;

/** Called once from the plugin entry after DSH injects the services. */
export function configureWorkingDirectoryService(
  service: { ensure?: (agent: unknown, signal?: unknown) => Promise<unknown> } | undefined,
): void {
  workingDirectoryService = service;
}

export interface ResolvedProjectCwd {
  cwd: string;
  /** True when THIS call wrote the session binding (the session's first CAD call). */
  newlyBound: boolean;
}

export interface ResolveProjectOptions {
  /**
   * Write-time guard. An unbound session whose cwd is a SUBDIRECTORY of an
   * ancestor project is refused instead of silently binding the ancestor:
   * that is how the wind-up-frog corpus landed at the repo root and had to be
   * copied/moved later. The caller must choose explicitly:
   *   - `init_project({dir})` to make the cwd a project, or
   *   - `cad_session({ action: "bind", args: { dir: ancestor } })` to declare the ancestor as the target.
   * Reads (`projectCwdOf`) stay permissive.
   */
  requireExplicit?: boolean;
  /**
   * Write/read tools: a CAD project must have been SELECTED explicitly.
   * There is no default from cwd/root. Unbound callers get an error telling
   * them to call `cad_session` action=bind (existing) or action=init (new).
   */
  requireSelection?: boolean;
  /** Read-only resolution: compute the path but do NOT write a session binding. */
  bind?: boolean;
}

/**
 * The ONE callable spelling of the project-selection tool.
 *
 * The model surface is the `cad_session` facade; `bind_project` / `init_project`
 * are internal op names that stopped being callable in the 2026-11-16 cutover.
 * Error text is the model's only guide here, so it must name a call the model can
 * actually make — a name absent from its catalog is a dead end, not a hint.
 */
export function cadSessionCall(action: 'bind' | 'init', dir: string): string {
  return `cad_session({ action: ${JSON.stringify(action)}, args: { dir: ${JSON.stringify(dir)} } })`;
}

/**
 * State + the exact call(s) that resolve "no project selected".
 *
 * The previous message offered two branches without saying which one applied, so
 * a caller had to guess (a session in a marker-less subdirectory guessed `bind`
 * and failed). This inspects the cwd it already has and names the consequence of
 * each branch; only the ambiguous case legitimately keeps two intents.
 */
export function projectChoiceHint(start: string | null): string {
  if (!start) {
    return `Select an existing project with ${cadSessionCall('bind', '<existing-project>')}, ` +
      `or create one with ${cadSessionCall('init', '<new-project>')}.`;
  }
  const cwd = resolve(start);
  const own = markerAt(cwd);
  if (own === 'project' || own === 'legacy') {
    return `The cwd ${cwd} is itself a CAD project: select it with ${cadSessionCall('bind', cwd)}.`;
  }
  if (own === 'workspace') {
    return `The cwd ${cwd} is a CAD WORKSPACE (a container, never a write target). ` +
      `Create a project inside it with ${cadSessionCall('init', join(cwd, 'my-part'))}, ` +
      'or select an existing member project by path.';
  }
  const resolved = resolveProjectRoot(cwd);
  if (resolved.root !== cwd) {
    if (resolved.marker === 'workspace') {
      return `The cwd ${cwd} is inside the workspace ${resolved.root} (a container, never a write target): ` +
        `create a project here with ${cadSessionCall('init', cwd)}.`;
    }
    return `The cwd ${cwd} is inside the project ${resolved.root} but is not itself a project.\n` +
      `  - to work in ${cwd}: ${cadSessionCall('init', cwd)}\n` +
      `  - to work in the existing project: ${cadSessionCall('bind', resolved.root)}`;
  }
  return `Nothing here or above ${cwd} is a project: ${cadSessionCall('init', cwd)} creates and selects one.`;
}

/** The refusal used by read/write tools before the session has selected a project. */
export function projectSelectionMessage(start: string | null): string {
  return 'No CAD project is selected for this session, and there is no default cwd/root. '
    + projectChoiceHint(start);
}

/** Async resolver: binding → live working directory → session header → server cwd. */
export async function resolveProjectCwd(exec: unknown, opts: ResolveProjectOptions = {}): Promise<ResolvedProjectCwd> {
  const agent = (exec as {
    agent?: { session?: { header?: { id?: unknown; cwd?: unknown } } };
  })?.agent;
  const rawId = agent?.session?.header?.id;
  const sessionId = typeof rawId === 'string' && rawId.trim() ? rawId : undefined;
  if (opts.requireSelection && sessionId) {
    const selected = readSessionBinding(sessionId);
    if (!selected) {
      throw new Error(projectSelectionMessage(await liveCwdOf(exec)));
    }
    return { cwd: selected, newlyBound: false };
  }
  // No session id is the headless/test path (scripts and maintenance calls have
  // no DSH session to select for). Interactive LLM calls always carry one, so the
  // explicit-selection rule is enforced where it matters and never becomes a
  // silent default for a user session.
  if (sessionId) {
    const bound = readSessionBinding(sessionId);
    if (bound) return { cwd: bound, newlyBound: false };
  }
  let start: string | undefined;
  try {
    const current = await workingDirectoryService?.ensure?.(agent, undefined);
    if (typeof current === 'string' && current.trim()) start = current;
  } catch {
    /* fall through to the durable header */
  }
  if (start === undefined) {
    const headerCwd = agent?.session?.header?.cwd;
    if (typeof headerCwd === 'string' && headerCwd.trim()) start = headerCwd;
  }
  let startDir = resolve(start ?? process.cwd());
  try { startDir = realpathSync(startDir); } catch { /* keep the resolved path */ }
  const resolved = resolveProjectRoot(startDir);
  const root = resolved.root;
  // FAIL CLOSED (write-time): a workspace root is never a project, and a cwd
  // inside an ancestor project that is not itself a project has two plausible
  // targets (the cwd and the ancestor). Picking the ancestor is what made the
  // original corpus land one level too high. Refuse and make the caller choose;
  // no post-hoc move is then needed.
  if (opts.requireExplicit && resolved.marker === 'workspace') {
    throw new Error(
      `CAD write target is a WORKSPACE, not a project: ${resolved.root}. ` +
      'A workspace holds projects and is never written to. Choose a member project, ' +
      `or create one with ${cadSessionCall('init', join(startDir, 'project-name'))}.`,
    );
  }
  if (opts.requireExplicit && root !== startDir && markerAt(startDir) === null) {
    throw new Error(
      `CAD write target is ambiguous: the session cwd ${startDir} is inside project ${root} but is not itself a project. ` +
      `Writing here would put versions in ${root}, and moving them later is exactly what this guard prevents. ` +
      `Choose explicitly: ` +
      `${cadSessionCall('init', startDir)} to make this directory a project, ` +
      `or ${cadSessionCall('bind', root)} if you really mean to write to ${root}; ` +
      `or cd to a project root before the first CAD call.`,
    );
  }
  let newlyBound = false;
  if (sessionId && opts.bind !== false) {
    newlyBound = readSessionBinding(sessionId) === undefined;
    writeSessionBinding(sessionId, root);
    if (newlyBound && sessionId) {
      pendingBindNotices.set(
        sessionId,
        `CAD project bound to ${root} (resolved from the session's working directory) — later cd calls do NOT switch; delete $DSH_HOME/cad/sessions/${safeSessionId(sessionId)}.json to rebind`,
      );
    }
  }
  return { cwd: root, newlyBound };
}

/** Compatibility wrapper: the resolved root only. */
export async function projectCwdOf(exec: unknown): Promise<string> {
  // A READ must not select a project as a side effect. The panel/route can ask
  // where a cwd resolves; only bind_project/init_project (or an explicit tool
  // call with requireSelection) may write the session choice.
  return (await resolveProjectCwd(exec, { bind: false })).cwd;
}

// First-bind echo (G5). A binding written from a WRONG cwd is what made the
// roberval corpus land at the repo root, and nothing surfaced the choice — the
// resolver just wrote it. The session's first CAD call now carries a notice in
// its reply, so a wrong bind is visible in the very turn that made it.
const pendingBindNotices = new Map<string, string>();

/** Pop the first-bind notice for this call's session, if this call wrote one. */
export function takeBindingNotice(exec: unknown): string | undefined {
  const sessionId = (exec as { agent?: { session?: { header?: { id?: unknown } } } })?.agent?.session?.header?.id;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return undefined;
  const notice = pendingBindNotices.get(sessionId);
  pendingBindNotices.delete(sessionId);
  return notice;
}

/**
 * Read-only answer to "which corpus would this session write to, and why?".
 *
 * WHY: the binding is sticky and was previously echoed only by `generate_part`.
 * A session whose first CAD call is a read/measure therefore had no way to ask
 * where it was bound; the wind-up-frog session discovered it only after v008.
 */
export interface ProjectInfo {
  sessionId: string | null;
  /** The bound corpus, or null when no binding exists yet. */
  boundRoot: string | null;
  boundAt: string | null;
  /** Marker kind at the bound root ('project' | 'legacy'), or null. */
  marker: ProjectRootMarker | null;
  /** The live working directory the resolver would start from. */
  liveCwd: string | null;
  /** True when this session has explicitly selected a project. */
  selected: boolean;
  /** The selected project root; absent/null when nothing has been selected. */
  wouldBindTo: string | null;
  /** Marker kind at the selected root; absent/null when nothing has been selected. */
  wouldBindMarker: ProjectRootMarker | null;
  /** True when the live cwd resolves to a different corpus than the binding. */
  mismatch: boolean;
  /** True when an UNBOUND session's cwd is inside a project but is not one:
   *  the first write is refused until the session selects one. */
  ambiguous: boolean;
  /** True when the resolved root is a workspace (a container, never a write target). */
  workspace: boolean;
  note: string;
}

export async function projectInfoFor(exec: unknown): Promise<ProjectInfo> {
  const agent = (exec as { agent?: { session?: { header?: { id?: unknown; cwd?: unknown } } } })?.agent;
  const rawId = agent?.session?.header?.id;
  const sessionId = typeof rawId === 'string' && rawId.trim() ? rawId : null;
  const binding = sessionId ? readSessionBindingRecord(sessionId) : undefined;
  let liveCwd: string | null = null;
  try {
    const current = await workingDirectoryService?.ensure?.(agent, undefined);
    if (typeof current === 'string' && current.trim()) liveCwd = current;
  } catch { /* fall through to the durable header */ }
  if (!liveCwd) {
    const headerCwd = agent?.session?.header?.cwd;
    if (typeof headerCwd === 'string' && headerCwd.trim()) liveCwd = headerCwd;
  }
  const resolved = resolveProjectRoot(liveCwd ?? process.cwd());
  const boundRoot = binding?.projectRoot ?? null;
  const marker = boundRoot ? markerAt(boundRoot) : null;
  const mismatch = Boolean(boundRoot && liveCwd && resolveProjectRoot(liveCwd).root !== boundRoot);
  const liveResolved = liveCwd ? resolve(liveCwd) : null;
  const ambiguous = Boolean(
    !boundRoot && liveResolved && resolved.root !== liveResolved && markerAt(liveResolved) === null,
  );
  const workspaceRoot = !boundRoot && resolved.marker === 'workspace' ? resolved.root : null;
  const note = !boundRoot
    ? `NO CAD project is selected for this session. There is no default cwd/root. ${projectChoiceHint(liveCwd)}`
    : `this session is BOUND to ${boundRoot}${mismatch ? `; its live cwd ${liveCwd} resolves elsewhere (${resolved.root}), but a bound session does not switch` : ''}`;
  return {
    sessionId,
    boundRoot,
    boundAt: binding?.boundAt ?? null,
    marker,
    liveCwd,
    selected: Boolean(boundRoot),
    wouldBindTo: boundRoot,
    wouldBindMarker: boundRoot ? marker : null,
    mismatch,
    ambiguous,
    workspace: Boolean(workspaceRoot),
    note,
  };
}

/**
 * Create ONLY a project marker (`cad-data/project.json`) in `dir`.
 *
 * This is the missing C-lite lifecycle action: `ensureProjectDir` stamps a
 * marker only on a write, and by then the first CAD call has already bound an
 * ancestor. `init_project` must be callable BEFORE that first call; it writes
 * no versions, parts or runs, and it never rebinds the calling session.
 */
/**
 * Change the project-level authoring kernel WITHOUT recreating the project.
 *
 * `createProjectMarker` sets `defaultKernel` only on a fresh marker, and the
 * tool surface is derived from the kernel — so an OpenSCAD project could not be
 * switched to CadQuery without starting a second project (which is exactly why
 * the two Bicycle sessions became two independent designs). This writes the
 * same marker field in place; existing versions keep their own backend pin.
 */
export async function setProjectKernel(
  dir: string,
  kernel: 'openscad' | 'cadquery',
): Promise<{ root: string; key: string; previous: string | null; kernel: string }> {
  const root = resolve(dir);
  const markerPath = join(root, 'cad-data', 'project.json');
  if (!existsSync(markerPath)) {
    throw new Error(`no project marker at ${markerPath}; create or select the project first: ${cadSessionCall('init', root)}`);
  }
  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
  const previous = typeof marker.defaultKernel === 'string' ? marker.defaultKernel : null;
  marker.defaultKernel = kernel;
  await writeJsonAtomic(markerPath, marker);
  clearProjectRootCache();
  return { root, key: String(marker.key ?? projectKey(root)), previous, kernel };
}

export async function createProjectMarker(
  dir: string,
  title?: string,
  defaultKernel?: 'openscad' | 'cadquery',
): Promise<{ root: string; key: string; created: boolean; inheritedFrom: string | null; note: string }> {
  const root = resolve(dir);
  // Resolve the ANCESTOR before creating anything: a bare `cad-data/` made here
  // would look like a legacy marker at `root` and hide the ancestor we need to
  // name in `inheritedFrom`.
  const inherited = resolveProjectRoot(root);
  if (inherited.root === root && inherited.marker === 'workspace') {
    throw new Error(
      `${root} is a CAD workspace, not a project. Create the project in a subdirectory, ` +
      'e.g. cad_session({ action: "init", args: { dir: "examples/my-part" } }), so the workspace stays a container.',
    );
  }
  const inheritedFrom = inherited.root !== root && inherited.marker !== 'new' ? inherited.root : null;
  mkdirSync(join(root, 'cad-data'), { recursive: true });
  const markerPath = join(root, 'cad-data', 'project.json');
  if (existsSync(markerPath)) {
    let key = projectKey(root);
    try {
      const parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
      if (typeof parsed?.key === 'string' && parsed.key.trim()) key = parsed.key;
    } catch { /* keep the derived key */ }
    return {
      root,
      key,
      created: false,
      inheritedFrom,
      note: `${root} already has a project marker; nothing was written. A session already bound elsewhere does not switch — open a new session with cwd=${root}.`,
    };
  }
  const key = projectKey(root);
  await writeJsonAtomic(markerPath, {
    schemaVersion: 1,
    cwd: root,
    key,
    title: (title?.trim() || basename(root) || 'project'),
    ...(defaultKernel ? { defaultKernel } : {}),
    createdAt: new Date().toISOString(),
  });
  clearProjectRootCache();
  return {
    root,
    key,
    created: true,
    inheritedFrom,
    note: `marker created${inheritedFrom ? ` INSIDE the ancestor project ${inheritedFrom} (it now shadows that project for new sessions)` : ''}. ` +
      'This call does NOT rebind the current session; open a new session with cwd=' + root + ' before the first CAD call.',
  };
}

/** The live working directory, or the durable header cwd, or null. */
const liveCwdBySession = new Map<string, string>();

/** Last live cwd observed for a session; used by synchronous prompt providers. */
export function cachedLiveCwd(sessionId: string | null | undefined): string | null {
  return sessionId ? liveCwdBySession.get(sessionId) ?? null : null;
}

export async function liveCwdOf(exec: unknown): Promise<string | null> {
  const agent = (exec as { agent?: { session?: { header?: { id?: unknown; cwd?: unknown } } } })?.agent;
  const id = typeof agent?.session?.header?.id === 'string' ? agent.session.header.id : null;
  try {
    const current = await workingDirectoryService?.ensure?.(agent, undefined);
    if (typeof current === 'string' && current.trim()) {
      if (id) liveCwdBySession.set(id, current);
      return current;
    }
  } catch { /* fall through to the durable header */ }
  const headerCwd = agent?.session?.header?.cwd;
  return typeof headerCwd === 'string' && headerCwd.trim() ? headerCwd : null;
}

/**
 * Explicitly bind this session to an EXISTING project root.
 *
 * This is the sanctioned way to say "yes, I mean the ancestor corpus" when the
 * cwd is a subdirectory. It refuses to rebind an already-bound session — a
 * wrong target is fixed by a new session, not by moving the corpus after the
 * fact. It never creates a marker; use `init_project` for that.
 */
export async function bindSessionToProject(
  exec: unknown,
  dir: string,
): Promise<{ root: string; marker: ProjectRootMarker; boundAt: string }> {
  const sessionId = (exec as { agent?: { session?: { header?: { id?: unknown } } } })?.agent?.session?.header?.id;
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('selecting a project needs a live session id; this caller has none to bind');
  }
  const existing = readSessionBinding(sessionId);
  if (existing) {
    throw new Error(
      `this session is already selected on ${existing}; a bound session does not switch. ` +
      'Start a new session with the target cwd and run the first CAD call there.',
    );
  }
  const root = resolve(dir);
  const marker = markerAt(root);
  if (marker === null) {
    throw new Error(
      `${root} has no cad-data/project.json marker. Make it a project first with ${cadSessionCall('init', root)}, ` +
      'then select it, or start a session there.',
    );
  }
  if (marker === 'workspace') {
    throw new Error(
      `${root} is a CAD workspace, not a project; a workspace cannot be selected. ` +
      `Create a project in a subdirectory first: ${cadSessionCall('init', join(root, 'my-part'))}.`,
    );
  }
  const boundAt = new Date().toISOString();
  writeSessionBinding(sessionId, root);
  return { root, marker, boundAt };
}

/** Store root for a tool call, creating the project directory if needed. */
export async function projectStoresFor(exec: unknown): Promise<ProjectStores> {
  const { cwd } = await resolveProjectCwd(exec, { requireSelection: true });
  const project = projectStores(cwd);
  await ensureProjectDir(project);
  return project;
}

/**
 * The project a browser request names, via `?project=<absolute dir>`.
 *
 * Deliberately a plain path rather than a session id: the routes are read-only
 * views, they must work for a project whose sessions are all closed, and the
 * panel already knows the cwd it is looking at. A relative or missing value
 * falls back to the server cwd instead of being resolved against anything —
 * `..` in a query string must never be able to name a different corpus.
 */
export function requestCwd(request: Request): string {
  const raw = new URL(request.url).searchParams.get('project')?.trim();
  return raw && isAbsolute(raw) ? raw : process.cwd();
}

/** Stores for a browser request (read-only path: does not create directories). */
export function requestStores(request: Request): ProjectStores {
  return projectStores(resolveProjectRoot(requestCwd(request)).root);
}

// `project.json` is written once per project; the memo keeps the write off the
// hot path of every tool call while still being idempotent across processes.
const ensured = new Set<string>();

/**
 * Create the project directory and stamp its identity.
 *
 * Written on the first WRITE (a tool call that produces a version or a run):
 * the identity file is what lets a human (or a future migration) map a hashed
 * directory name back to the project it belongs to.
 */
export async function ensureProjectDir(project: ProjectStores): Promise<void> {
  if (ensured.has(project.root)) return;
  await mkdir(project.root, { recursive: true });
  const markerPath = join(project.root, 'project.json');
  // The marker is USER STATE now (title, defaultKernel, and future fields). A
  // write-time stamp must create it, never re-stamp it: this used to overwrite
  // init_project({defaultKernel:"cadquery"}) on the first generate_part and
  // silently send the session back to the global OpenSCAD default.
  if (!existsSync(markerPath)) {
    try {
      await writeFile(markerPath, `${JSON.stringify({
        schemaVersion: 1,
        cwd: project.cwd,
        key: projectKey(project.cwd),
        title: basename(project.cwd) || project.cwd,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
    } catch { /* the corpus is still usable without its identity stamp */ }
  }
  ensured.add(project.root);
  clearProjectRootCache();
}
