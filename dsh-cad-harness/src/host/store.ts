// The project's READ PORT: one place that owns the corpus snapshot, the address
// grammar, and the change sequence.
//
// WHY this exists (and why it is not a database):
//
//   * Every consumer used to read the three manifests itself — the products
//     route, the panel poller, the sandbox, the tools. Nothing was cached, so a
//     3 s poll re-read and re-built the whole tree (measured 1.09 ms at 83
//     versions, quadratic before T0.2), and the "did anything change?" question
//     had one answer per caller.
//   * The queue, the panel's history and any future deep link all need the same
//     question answered the same way: "given this id, what is it, and is it
//     still current?" — `resolve()`.
//
// The STORAGE stays files + manifests (DESIGN §6.8): versions and runs are
// immutable commits and the index is rebuildable. This module is a cache in front
// of them, keyed by the corpus root and invalidated by the manifests' mtime+size.
// A database, when it comes, slots in UNDER this port without touching callers.
//
// The change sequence is in-memory and monotonic per corpus: it advances when a
// snapshot observes a different manifest stamp. It is NOT durable — a restart
// starts again at 1, which is why the route also sends an ETag (a content stamp)
// and the client sends `If-None-Match`.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readManifest } from './version.ts';
import { listParts, openPartStore } from './parts.ts';
import { listRuns, openRunStore } from './runs.ts';
import { openVersionStore } from './version.ts';
import { buildProductsWire } from './products.ts';
import type { ProductsWire, PartWire } from '../shared/products-wire.ts';
import type { RunProduct, VersionProduct } from '../shared/types.ts';
import type { ProjectStores } from './project.ts';

/** What an address resolves to. `isCurrent` is the history gate's input. */
export type Resolved =
  | { kind: 'version'; id: string; version: VersionProduct; partId: string | null; partName: string | null; isCurrent: boolean }
  | { kind: 'run'; id: string; run: RunProduct; isCurrent: boolean }
  | { kind: 'part'; id: string; part: PartWire }
  | { kind: 'file'; path: string; exists: boolean };

export interface Snapshot {
  wire: ProductsWire;
  /** Content stamp of the three manifests (mtime + size), also the ETag basis. */
  stamp: string;
  /** Monotonic per corpus; advances when the stamp changes. */
  seq: number;
}

async function fileStamp(file: string): Promise<string> {
  try {
    const st = await stat(file);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return '-';
  }
}

/**
 * One corpus. Construct with {@link storeFor} (a ProjectStores) or
 * {@link storeAt} (a bare data root, which is what the UI sandbox serves).
 */
export class CadStore {
  private readonly root: string;
  private readonly cwd: string;
  private wire: ProductsWire | null = null;
  private stamp = '';
  private seq = 0;
  private loading: Promise<Snapshot> | null = null;

  // Explicit fields, not TypeScript parameter properties: the acceptance scripts
  // run these modules through Node's strip-only type removal, which refuses them.
  constructor(root: string, cwd: string) {
    this.root = root;
    this.cwd = cwd;
  }

  /** The three manifests' stamp: cheap (`stat` × 3), no reads. */
  async currentStamp(): Promise<string> {
    const [v, p, r] = await Promise.all([
      fileStamp(join(this.root, 'manifest.json')),
      fileStamp(join(this.root, 'parts', 'manifest.json')),
      fileStamp(join(this.root, 'runs', 'manifest.json')),
    ]);
    return `${v}|${p}|${r}`;
  }

  /**
   * The tree, rebuilt only when a manifest changed. Concurrent callers share one
   * rebuild (the poller and a route can ask at the same time).
   */
  async snapshot(): Promise<Snapshot> {
    const stamp = await this.currentStamp();
    if (this.wire && stamp === this.stamp) {
      return { wire: this.wire, stamp, seq: this.seq };
    }
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const [vm, parts, runs] = await Promise.all([
        readManifest(openVersionStore(this.root)),
        listParts(openPartStore(this.root)),
        listRuns(openRunStore(this.root)),
      ]);
      this.wire = buildProductsWire(vm.versions, parts, runs);
      this.stamp = stamp;
      this.seq += 1;
      return { wire: this.wire, stamp, seq: this.seq };
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  /**
   * Has anything changed since `since`? The answer is the same one the snapshot
   * just computed — this only packages it for the conditional-request route.
   */
  async changes(since: number): Promise<{ seq: number; changed: boolean; stamp: string }> {
    const s = await this.snapshot();
    return { seq: s.seq, changed: s.seq !== since, stamp: s.stamp };
  }

  /** Drop the cache (a writer in this process just changed the corpus). */
  invalidate(): void {
    this.wire = null;
    this.stamp = '';
  }

  /**
   * Resolve an address to an object, with its currency.
   *
   * The grammar is the one the navigator, the queue and any deep link share:
   *   `v029`      a version          (+ isCurrent: newest of its part)
   *   `r041`      a run              (+ isCurrent: not superseded)
   *   `p005`      a part
   *   `u:<rel>`   an unregistered file, relative to the session workspace
   * Anything else is null — an address we cannot resolve is not a finding.
   */
  async resolve(address: string): Promise<Resolved | null> {
    const a = String(address ?? '').trim();
    if (!a) return null;
    const { wire } = await this.snapshot();

    if (/^v\d{3,}$/.test(a)) {
      for (const part of wire.parts) {
        const version = part.versions.find((v) => v.id === a);
        if (!version) continue;
        // versions are newest-first, so the head IS the current one (one rule).
        return {
          kind: 'version', id: a, version, partId: part.id, partName: part.name,
          isCurrent: part.versions[0]?.id === a,
        };
      }
      // A version whose partId has no part entry still resolves (legacy corpus).
      const version = wire.parts.flatMap((p) => p.versions).find((v) => v.id === a) ?? null;
      if (!version) return null;
      return { kind: 'version', id: a, version, partId: version.partId ?? null, partName: null, isCurrent: false };
    }

    if (/^r\d{3,}$/.test(a)) {
      const run = wire.runs.find((r) => r.id === a) ?? null;
      if (!run) return null;
      return { kind: 'run', id: a, run, isCurrent: !run.supersededBy };
    }

    if (/^p\d{3,}$/.test(a)) {
      const part = wire.parts.find((p) => p.id === a) ?? null;
      return part ? { kind: 'part', id: a, part } : null;
    }

    if (a.startsWith('u:')) {
      const rel = a.slice(2);
      if (!rel) return null;
      let exists = false;
      try { await stat(join(this.cwd, rel)); exists = true; } catch { /* absent */ }
      return { kind: 'file', path: rel, exists };
    }

    return null;
  }
}

const stores = new Map<string, CadStore>();

/** The store for a project (keyed by its corpus root; the cwd is kept for files). */
export function storeFor(project: ProjectStores): CadStore {
  const hit = stores.get(project.root);
  if (hit) return hit;
  const store = new CadStore(project.root, project.cwd);
  stores.set(project.root, store);
  return store;
}

/** The store for a bare data root — the UI sandbox's shape (cwd == root). */
export function storeAt(root: string, cwd: string = root): CadStore {
  const hit = stores.get(root);
  if (hit) return hit;
  const store = new CadStore(root, cwd);
  stores.set(root, store);
  return store;
}
