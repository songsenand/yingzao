// Mesh utilities: STL parsing (binary + ASCII), vertex dedup, watertight check,
// shell counting, and the binary writer that closes the loop back to disk.
//
// Format detection is deliberately *exact* rather than heuristic. A binary STL
// may begin with "solid" inside its 80-byte header (a legacy of exporters that
// copied the ASCII convention), so the only reliable discriminator is the
// length identity `84 + triCount*50 === length`. Getting this wrong is not
// cosmetic: feeding an ASCII file to the binary parser reads a garbage triangle
// count and reports "STL truncated", which is exactly the kind of misleading
// error an import path must never produce.

export interface ParsedMesh {
  vertProperties: Float32Array; // xyz per vertex, deduped
  triVerts: Uint32Array;        // 3 indices per triangle
}

/**
 * Shared vertex dedup, so the binary and ASCII parsers of the same geometry
 * produce byte-identical meshes (an acceptance assertion depends on it).
 * Quantised to 1e-5 mm — far below any printer, far above float32 noise.
 */
function vertexKey(x: number, y: number, z: number): string {
  return `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
}

/** Indexed-mesh builder shared by both parsers. */
class MeshBuilder {
  private readonly index = new Map<string, number>();
  private readonly verts: number[] = [];
  private readonly tris: number[] = [];
  /** Degenerate (zero-area) facets seen in the source, for honest reporting. */
  degenerate = 0;

  vertex(x: number, y: number, z: number): number {
    const k = vertexKey(x, y, z);
    let idx = this.index.get(k);
    if (idx === undefined) {
      idx = this.verts.length / 3;
      this.index.set(k, idx);
      this.verts.push(x, y, z);
    }
    return idx;
  }

  triangle(a: number, b: number, c: number): void {
    if (a === b || b === c || a === c) { this.degenerate++; return; }
    this.tris.push(a, b, c);
  }

  finish(): ParsedMesh {
    return { vertProperties: new Float32Array(this.verts), triVerts: new Uint32Array(this.tris) };
  }
}

/**
 * Parse a binary STL into a deduped triangle soup → indexed mesh.
 * STL stores per-triangle vertices, so identical positions must be merged
 * for Manifold to see shared edges.
 */
export function parseBinaryStl(data: Uint8Array): ParsedMesh {
  if (data.length < 84) throw new Error(`STL too short: ${data.length} bytes`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const triCount = view.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (data.length < expected) throw new Error(`STL truncated: ${data.length} < ${expected}`);

  const b = new MeshBuilder();
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    off += 12; // skip facet normal
    const tri: number[] = [];
    for (let v = 0; v < 3; v++) {
      const x = view.getFloat32(off, true);
      const y = view.getFloat32(off + 4, true);
      const z = view.getFloat32(off + 8, true);
      off += 12;
      tri.push(b.vertex(x, y, z));
    }
    off += 2; // attribute byte count
    b.triangle(tri[0]!, tri[1]!, tri[2]!);
  }
  return b.finish();
}

/**
 * Parse an ASCII STL. Tolerates the usual exporter slop: arbitrary whitespace,
 * `facet normal` / `outer loop` / `endloop` / `endfacet` / `endsolid`, and the
 * (nonstandard but common) case of vertices without a preceding `outer loop`.
 */
export function parseAsciiStl(data: Uint8Array): ParsedMesh {
  const text = new TextDecoder().decode(data);
  const b = new MeshBuilder();
  const pending: number[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    // `vertex x y z` is the only keyword that carries geometry.
    if (!line.startsWith('vertex')) continue;
    const parts = line.split(/\s+/);
    const x = Number(parts[1]), y = Number(parts[2]), z = Number(parts[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`ASCII STL: unparseable vertex line "${line.slice(0, 60)}"`);
    }
    pending.push(b.vertex(x, y, z));
    if (pending.length === 3) {
      b.triangle(pending[0]!, pending[1]!, pending[2]!);
      pending.length = 0;
    }
  }
  if (pending.length !== 0) throw new Error(`ASCII STL: ${pending.length} dangling vertex/vertices (not a multiple of 3)`);
  return b.finish();
}

export type StlFormat = 'binary' | 'ascii' | 'unknown';

/**
 * Which STL flavour these bytes are. The binary test is the exact length
 * identity — a binary file whose 80-byte header says "solid" must not be
 * mistaken for ASCII, and an ASCII file never satisfies the identity.
 */
export function detectStlFormat(data: Uint8Array): StlFormat {
  if (data.length >= 84) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const triCount = view.getUint32(80, true);
    if (84 + triCount * 50 === data.length) return 'binary';
  }
  const head = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 2048))).trimStart();
  if (/^solid\b/.test(head) && /\bfacet\b/.test(head)) return 'ascii';
  return 'unknown';
}

/** Parse either STL flavour, with an error that says what was actually seen. */
export function parseStl(data: Uint8Array): { mesh: ParsedMesh; format: StlFormat; degenerate: number } {
  const format = detectStlFormat(data);
  if (format === 'binary') return { mesh: parseBinaryStl(data), format, degenerate: 0 };
  if (format === 'ascii') return { mesh: parseAsciiStl(data), format, degenerate: 0 };
  throw new Error(
    `not an STL I can read (${data.length} bytes; neither binary — 84+n*50 — nor an ASCII "solid/facet" file). ` +
    `If this is STEP/3MF/OBJ, see the import notes.`,
  );
}

/**
 * Serialize an indexed mesh back to binary STL.
 *
 * Needed so a stored version is self-consistent: what the store holds is
 * exactly the mesh that was welded, scaled and measured — never the raw bytes
 * of the file that came in.
 */
export function writeBinaryStl(mesh: ParsedMesh, header = 'dsh-cad-harness export'): Uint8Array {
  const triCount = mesh.triVerts.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set(new TextEncoder().encode(header.slice(0, 79).padEnd(80, ' ')).subarray(0, 80), 0);
  view.setUint32(80, triCount, true);
  let off = 84;
  const v = mesh.vertProperties;
  for (let t = 0; t < triCount; t++) {
    const a = mesh.triVerts[t * 3]! * 3, b = mesh.triVerts[t * 3 + 1]! * 3, c = mesh.triVerts[t * 3 + 2]! * 3;
    // Facet normal from the winding (STL's normal field is advisory; consumers
    // recompute, but writing it keeps third-party viewers happy).
    const ux = v[b]! - v[a]!, uy = v[b + 1]! - v[a + 1]!, uz = v[b + 2]! - v[a + 2]!;
    const wx = v[c]! - v[a]!, wy = v[c + 1]! - v[a + 1]!, wz = v[c + 2]! - v[a + 2]!;
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const [x, y, z] of [[nx, ny, nz], [v[a]!, v[a + 1]!, v[a + 2]!], [v[b]!, v[b + 1]!, v[b + 2]!], [v[c]!, v[c + 1]!, v[c + 2]!]] as [number, number, number][]) {
      view.setFloat32(off, x, true);
      view.setFloat32(off + 4, y, true);
      view.setFloat32(off + 8, z, true);
      off += 12;
    }
    view.setUint16(off, 0, true);
    off += 2;
  }
  return bytes;
}

/**
 * Connected components by shared *edge* (union-find over triangles).
 *
 * Edge- rather than vertex-connectivity, because that is the criterion a
 * slicer uses to decide "one object": two bodies that merely touch at a point
 * or a line are not one solid, and reporting them as one is how an import
 * silently ships a broken file downstream.
 */
export function shellCount(mesh: ParsedMesh): number {
  const triCount = mesh.triVerts.length / 3;
  if (triCount === 0) return 0;
  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) { const n = parent[x]!; parent[x] = r; x = n; }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const edgeOwner = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    const a = mesh.triVerts[t * 3]!, b = mesh.triVerts[t * 3 + 1]!, c = mesh.triVerts[t * 3 + 2]!;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const key = p < q ? `${p}_${q}` : `${q}_${p}`;
      const owner = edgeOwner.get(key);
      if (owner === undefined) edgeOwner.set(key, t);
      else union(owner, t);
    }
  }
  const roots = new Set<number>();
  for (let t = 0; t < triCount; t++) roots.add(find(t));
  return roots.size;
}

/**
 * Connected-body analysis: how many mutually disconnected solids a mesh
 * contains, each with its own bounding box (mm). Two cubes that share a face
 * (a union) are ONE body — they share vertices, so the edge union-find joins
 * them; two cubes apart in space are TWO.
 *
 * This is the truth behind the discipline "a part must be a single connected
 * solid" (DESGIGN §18): `shells` above only counts; this locates each body so
 * the model can tell which fragment is which.
 */
export function connectedBodies(mesh: ParsedMesh): {
  count: number;
  bodies: { min: [number, number, number]; max: [number, number, number] }[];
} {
  const triCount = mesh.triVerts.length / 3;
  if (triCount === 0) return { count: 0, bodies: [] };
  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) { const n = parent[x]!; parent[x] = r; x = n; }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const edgeOwner = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    const a = mesh.triVerts[t * 3]!, b = mesh.triVerts[t * 3 + 1]!, c = mesh.triVerts[t * 3 + 2]!;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const key = p < q ? `${p}_${q}` : `${q}_${p}`;
      const owner = edgeOwner.get(key);
      if (owner === undefined) edgeOwner.set(key, t);
      else union(owner, t);
    }
  }
  const bodiesByRoot = new Map<number, { min: [number, number, number]; max: [number, number, number] }>();
  for (let t = 0; t < triCount; t++) {
    const root = find(t);
    let body = bodiesByRoot.get(root);
    if (!body) { body = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; bodiesByRoot.set(root, body); }
    for (let k = 0; k < 3; k++) {
      const v = mesh.triVerts[t * 3 + k]!;
      const x = mesh.vertProperties[v * 3]!, y = mesh.vertProperties[v * 3 + 1]!, z = mesh.vertProperties[v * 3 + 2]!;
      body.min[0] = Math.min(body.min[0]!, x); body.min[1] = Math.min(body.min[1]!, y); body.min[2] = Math.min(body.min[2]!, z);
      body.max[0] = Math.max(body.max[0]!, x); body.max[1] = Math.max(body.max[1]!, y); body.max[2] = Math.max(body.max[2]!, z);
    }
  }
  const bodies = [...bodiesByRoot.values()]
    .map((b) => ({ min: b.min.map((n) => +n.toFixed(3)) as [number, number, number], max: b.max.map((n) => +n.toFixed(3)) as [number, number, number] }))
    .sort((a, b) => (b.max[0]! - b.min[0]!) * (b.max[1]! - b.min[1]!) - (a.max[0]! - a.min[0]!) * (a.max[1]! - a.min[1]!));
  return { count: bodies.length, bodies };
}

/**
 * Watertight check: in a closed 2-manifold every directed edge appears exactly
 * once and every undirected edge is shared by exactly two triangles.
 */
export function isWatertight(mesh: ParsedMesh): { watertight: boolean; edgeStats: { directed: Map<string, number>; undirectedBad: number } } {
  const directed = new Map<string, number>();
  const count = (a: number, b: number, k: string) => directed.set(k, (directed.get(k) ?? 0) + 1);
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const a = mesh.triVerts[t]!, b = mesh.triVerts[t + 1]!, c = mesh.triVerts[t + 2]!;
    count(a, b, `${a}>${b}`); count(b, c, `${b}>${c}`); count(c, a, `${c}>${a}`);
  }
  // Every directed edge must appear exactly once, and its reverse must exist.
  let undirectedBad = 0;
  for (const [k, n] of directed) {
    if (n !== 1) { undirectedBad++; continue; }
    const [a, b] = k.split('>');
    if (!directed.has(`${b}>${a}`)) undirectedBad++;
  }
  return { watertight: undirectedBad === 0 && mesh.triVerts.length > 0, edgeStats: { directed, undirectedBad } };
}

/** Signed volume via divergence theorem sum (works for closed meshes). */
export function meshVolume(mesh: ParsedMesh): number {
  let vol = 0;
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const a = mesh.triVerts[t]! * 3, b = mesh.triVerts[t + 1]! * 3, c = mesh.triVerts[t + 2]! * 3;
    const ax = mesh.vertProperties[a]!, ay = mesh.vertProperties[a! + 1]!, az = mesh.vertProperties[a! + 2]!;
    const bx = mesh.vertProperties[b]!, by = mesh.vertProperties[b! + 1]!, bz = mesh.vertProperties[b! + 2]!;
    const cx = mesh.vertProperties[c]!, cy = mesh.vertProperties[c! + 1]!, cz = mesh.vertProperties[c! + 2]!;
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(vol);
}

export function boundingBox(mesh: ParsedMesh): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.vertProperties.length; i += 3) {
    for (let d = 0; d < 3; d++) {
      const v = mesh.vertProperties[i + d]!;
      if (v < min[d]) min[d] = v;
      if (v > max[d]) max[d] = v;
    }
  }
  return { min, max };
}

/** Centre of a mesh's bounding box. */
export function boundingBoxCentre(mesh: ParsedMesh): [number, number, number] {
  const { min, max } = boundingBox(mesh);
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

/**
 * A copy of `mesh` with every vertex shifted by −pivot.
 *
 * This is how a part gets a body origin it can be ROTATED about. Simulation
 * bodies rotate about their own origin, while every part in this corpus is
 * modelled in world coordinates with the body at (0,0,0) — so a driven gear
 * modelled at z=265 does not spin on its shaft, it swings on a 265mm arm. Rebase
 * the geometry on the axis and put the body there, and the same pose arithmetic
 * means what everyone assumed it meant.
 */
export function rebaseMesh(mesh: ParsedMesh, pivot: [number, number, number]): ParsedMesh {
  const vertProperties = new Float32Array(mesh.vertProperties.length);
  for (let i = 0; i < mesh.vertProperties.length; i += 3) {
    vertProperties[i] = mesh.vertProperties[i]! - pivot[0];
    vertProperties[i + 1] = mesh.vertProperties[i + 1]! - pivot[1];
    vertProperties[i + 2] = mesh.vertProperties[i + 2]! - pivot[2];
  }
  return { vertProperties, triVerts: mesh.triVerts };
}

/**
 * A copy of `mesh` with every vertex put through the affine map `p → m·p + t`.
 *
 * This is how a manifest `pose` (rotate about a datum axis) reaches the mesh:
 * Manifold only takes Euler angles, and folding a general axis-angle rotation
 * through them is where sign conventions go to die. Transforming the vertices
 * BEFORE welding keeps "is this a solid?" asked of exactly the geometry that
 * ships, and keeps BVH consumers (which read the transformed mesh) in the same
 * frame as the solid.
 */
export function transformMesh(
  mesh: ParsedMesh,
  m: readonly (readonly [number, number, number])[],
  t: readonly [number, number, number] = [0, 0, 0],
): ParsedMesh {
  const vertProperties = new Float32Array(mesh.vertProperties.length);
  for (let i = 0; i < mesh.vertProperties.length; i += 3) {
    const x = mesh.vertProperties[i]!, y = mesh.vertProperties[i + 1]!, z = mesh.vertProperties[i + 2]!;
    vertProperties[i] = m[0]![0]! * x + m[0]![1]! * y + m[0]![2]! * z + t[0];
    vertProperties[i + 1] = m[1]![0]! * x + m[1]![1]! * y + m[1]![2]! * z + t[1];
    vertProperties[i + 2] = m[2]![0]! * x + m[2]![1]! * y + m[2]![2]! * z + t[2];
  }
  return { vertProperties, triVerts: mesh.triVerts };
}
