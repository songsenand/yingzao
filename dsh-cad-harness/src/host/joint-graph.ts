// Joint-graph facts shared by both simulation engines.
//
// WHY THIS EXISTS: a closed loop is a property of the KINEMATIC GRAPH, not of a
// solver. The Roberval balance has five links and six hinges, so two edges close
// a loop; the same run also passes. Reporting `closedLoop: true` beside the
// verdict keeps that fact visible without turning it into a gate (the old
// README claimed closed loops were impossible, which was wrong for the reason
// the report never said).
//
// The rule is the standard union-find one: walk the joints in declaration order;
// an edge whose endpoints are already connected closes a cycle. `loopJoints`
// names exactly those edges, so a reader can point at the loop instead of
// re-deriving it.

export interface JointEndpoints {
  bodyA: string;
  bodyB: string;
}

/**
 * Joints that close a loop, in declaration order. A tree returns `[]`.
 *
 * Parallel edges (two joints between the same pair) also count: the second one
 * is redundant, and that redundancy is exactly what a solver has to reconcile.
 */
export function jointLoopClosers(joints: readonly JointEndpoints[]): string[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.has(cur) && parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const closers: string[] = [];
  for (const j of joints) {
    const a = find(j.bodyA);
    const b = find(j.bodyB);
    if (a === b) {
      closers.push(`${j.bodyA}~${j.bodyB}`);
      continue;
    }
    union(a, b);
  }
  return closers;
}
