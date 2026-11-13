import { t as tr } from './i18n.ts';
// The MACHINE as a browsing object: what an assembly manifest says the project
// IS, reduced to the two facts the navigator needs.
//
// WHY: `assembly.json` already models the machine (root → part nodes → part@version
// with transforms), but the panel only ever saw the RUNS that audited it — split
// across 仿真 / 检查 / 组件 / 契约. microscope5's 69 runs are 59 machine-level; with
// no machine object they had no home, and the navigator's top level was a pile of
// four run categories instead of "the machine, its 16 parts, and the loose files".
//
// Pure and dependency-free so it is testable without a DOM (accept-machine.mjs).

export interface MachineNode {
  /** Node id inside the manifest (e.g. `base`, `stirrupL`). */
  id: string;
  /** Part NAME the node references (the manifest's `part` field). */
  part: string;
  /** Version pinned by the node, when it declares one. */
  version: string | null;
  /**
   * BOM facts the manifest MAY carry (schema: qty / material / source / stockRef).
   * They were dropped by the reader, so the panel could not even say whether a
   * BOM existed — "no list" and "empty list" looked identical. Kept verbatim:
   * absent means "not declared", which is information, not zero.
   */
  qty?: number;
  material?: string;
  source?: string;
  stockRef?: string;
}

export interface Machine {
  /** Human name: the manifest's `name`, else the root's, else "整机". */
  name: string;
  /** Part nodes in manifest order (duplicates kept: two hangers are two nodes). */
  nodes: MachineNode[];
  /** Distinct part names — what the navigator's "16 零件" line counts. */
  distinctParts: number;
  /**
   * How much of a CONTRACT this manifest actually is. A count of interfaces is not
   * a contract: an interface with no tolerance is unevaluable, and a BOM node with
   * no qty/material is a name. The card says so instead of letting "25 接口" imply
   * 25 checked requirements.
   */
  contract: { interfaces: number; withTolerance: number };
}

/**
 * Reduce an `assembly.json` payload to a {@link Machine}, or null when there is
 * no usable machine (no root, or no part nodes — a bare manifest is not a machine).
 *
 * Nested assemblies are walked: a child of kind `assembly` contributes its own
 * part nodes, so a sub-assembly does not hide half the machine.
 */
export function parseMachine(raw: unknown): Machine | null {
  const doc = raw as { name?: unknown; root?: unknown } | null;
  const root = doc?.root as { id?: unknown; kind?: unknown; name?: unknown; children?: unknown } | undefined;
  if (!doc || !root) return null;

  const nodes: MachineNode[] = [];
  const walk = (n: { kind?: unknown; id?: unknown; part?: unknown; name?: unknown; version?: unknown; children?: unknown }): void => {
    if (!n) return;
    // Two node shapes exist in the corpus: `part` (toy-balance) and `name`
    // (microscope5). The schema allows both, so the reader must too — reading only
    // `part` silently produced "no machine" for a perfectly good manifest.
    const ref = typeof n.part === 'string' && n.part.trim()
      ? n.part.trim()
      : typeof n.name === 'string' && n.name.trim() ? n.name.trim() : '';
    if (n.kind === 'part' && ref) {
      const node: MachineNode = {
        id: typeof n.id === 'string' && n.id ? n.id : String(nodes.length + 1),
        part: ref,
        version: typeof n.version === 'string' && n.version ? n.version : null,
      };
      const with0 = n as { qty?: unknown; material?: unknown; source?: unknown; stockRef?: unknown };
      if (typeof with0.qty === 'number') node.qty = with0.qty;
      if (typeof with0.material === 'string' && with0.material) node.material = with0.material;
      if (typeof with0.source === 'string' && with0.source) node.source = with0.source;
      if (typeof with0.stockRef === 'string' && with0.stockRef) node.stockRef = with0.stockRef;
      nodes.push(node);
    }
    if (Array.isArray(n.children)) for (const child of n.children) walk(child as typeof n);
  };
  walk(root);
  if (nodes.length === 0) return null;

  const name = [doc.name, root.name, root.id]
    .find((x): x is string => typeof x === 'string' && x.trim().length > 0) ?? tr('ui.machine.name');

  // Interfaces live on the node that owns the pair they connect, so they are
  // counted during the same walk (a nested assembly contributes its own).
  let interfaces = 0;
  let withTolerance = 0;
  const walkIfaces = (n: { interfaces?: unknown; children?: unknown }): void => {
    if (!n) return;
    if (Array.isArray(n.interfaces)) {
      for (const it of n.interfaces) {
        if (!it || typeof it !== 'object') continue;
        interfaces++;
        const tol = (it as { tolerance?: { min?: unknown; max?: unknown } }).tolerance;
        if (tol && typeof tol.min === 'number' && typeof tol.max === 'number') withTolerance++;
      }
    }
    if (Array.isArray(n.children)) for (const c of n.children) walkIfaces(c as typeof n);
  };
  walkIfaces(root);

  return {
    name: name.trim(),
    nodes,
    distinctParts: new Set(nodes.map((n) => n.part)).size,
    contract: { interfaces, withTolerance },
  };
}
