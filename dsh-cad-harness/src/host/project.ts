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
export type ProjectRootMarker = 'project' | 'legacy' | 'new';

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
  if (!isDirectory(cadData)) return null;
  return existsSync(join(cadData, 'project.json')) ? 'project' : 'legacy';
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

function readSessionBinding(sessionId: string): string | undefined {
  const cached = sessionBindingCache.get(sessionId);
  if (cached && isDirectory(cached)) return cached;
  if (cached) sessionBindingCache.delete(sessionId);
  try {
    const parsed = JSON.parse(readFileSync(sessionBindingPath(sessionId), 'utf8'));
    const root = parsed?.projectRoot;
    if (typeof root === 'string' && root.trim() && isDirectory(root)) {
      sessionBindingCache.set(sessionId, root);
      return root;
    }
  } catch { /* no binding yet, or unreadable: fall back to the resolver */ }
  return undefined;
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

/** Async resolver: binding → live working directory → session header → server cwd. */
export async function resolveProjectCwd(exec: unknown): Promise<ResolvedProjectCwd> {
  const agent = (exec as {
    agent?: { session?: { header?: { id?: unknown; cwd?: unknown } } };
  })?.agent;
  const rawId = agent?.session?.header?.id;
  const sessionId = typeof rawId === 'string' && rawId.trim() ? rawId : undefined;
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
  const root = resolveProjectRoot(start ?? process.cwd()).root;
  let newlyBound = false;
  if (sessionId) {
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
  return (await resolveProjectCwd(exec)).cwd;
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

/** Store root for a tool call, creating the project directory if needed. */
export async function projectStoresFor(exec: unknown): Promise<ProjectStores> {
  const { cwd } = await resolveProjectCwd(exec);
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
  try {
    await writeFile(join(project.root, 'project.json'), `${JSON.stringify({
      schemaVersion: 1,
      cwd: project.cwd,
      key: projectKey(project.cwd),
      title: basename(project.cwd) || project.cwd,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  } catch { /* the corpus is still usable without its identity stamp */ }
  ensured.add(project.root);
  clearProjectRootCache();
}
