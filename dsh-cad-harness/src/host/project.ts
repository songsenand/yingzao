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
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { openPartStore, type PartStore } from './parts.ts';
import { openRunStore, type RunStore } from './runs.ts';
import { openVersionStore, type VersionStore } from './version.ts';

/** `$DSH_HOME`, or `~/.dsh` — the same root session logs and attachments live under. */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : join(homedir(), '.dsh');
}

/** Every project's data lives under here; `telemetry` is the one non-project sibling. */
export function projectsHome(): string {
  return join(dshHome(), 'cad');
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
  const root = join(projectsHome(), projectKey(canonical));
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
 * A call with no agent (a maintenance caller, a script) falls back to the
 * server's own cwd, which is the workspace the profile was started in.
 */
export function projectCwdOf(exec: unknown): string {
  const cwd = (exec as { agent?: { session?: { header?: { cwd?: unknown } } } })
    ?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd();
}

/** Store root for a tool call, creating the project directory if needed. */
export async function projectStoresFor(exec: unknown): Promise<ProjectStores> {
  const project = projectStores(projectCwdOf(exec));
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
  return projectStores(requestCwd(request));
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
}
