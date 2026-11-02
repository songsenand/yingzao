#!/usr/bin/env python3
"""check_appearance 的只读原型（原型，不是宿主工具）。

作用域是**成套**：输入 assembly manifest，输出"哪里违规、在哪、差多少"。
只读：不改几何、不给修复动作、不进 preflight。

三条规则（v1）：

  sharp-edge   可见凸锐边总长（mm）。计数不可用——圆角自身的分段会把计数抬高，
               总长才随圆角下降（见 docs/APPEARANCE-PLAN.md §9）。
  termination  平端面：轴对齐、面积 ≤ 40 mm²、边界全是 90° 直角边 —— 即"直接切断"。
  silhouette   剪影宽度剖面：腰/峰、顶底比、对称 IoU。注意力层，不判决。

可见性：从 12 个视角向每个锐边簇质心发射线，得分 = 可见视角 / 总视角。
被遮挡的锐边不计入判决，但必须报数（不许静默丢弃）。

用法：
  python appearance_probe.py <manifest.json> [--json out.json] [--cell 10] [--views 12]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field

import numpy as np
import trimesh
from scipy.signal import find_peaks
from scipy.ndimage import binary_dilation

MIN_FEATURE_MM = 1.5
REFERENCE_PART = ("外购", "螺钉", "螺母", "螺栓", "销", "M3", "screw", "nut", "bolt")


# ---------------------------------------------------------------- manifest

def load_manifest(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def walk_parts(node: dict):
    """Yield (id, version, transform, name) for every part in the tree."""
    if node.get("kind") == "part":
        label = node.get("name") or node.get("part") or ""
        yield (node.get("id", "?"), node.get("version"), node.get("transform") or {}, label,
               node.get("role"), node.get("source"))
        return
    for child in node.get("children", []):
        yield from walk_parts(child)


def rotation(rx: float, ry: float, rz: float) -> np.ndarray:
    rx, ry, rz = np.radians([rx, ry, rz])
    Rx = np.array([[1, 0, 0], [0, np.cos(rx), -np.sin(rx)], [0, np.sin(rx), np.cos(rx)]])
    Ry = np.array([[np.cos(ry), 0, np.sin(ry)], [0, 1, 0], [-np.sin(ry), 0, np.cos(ry)]])
    Rz = np.array([[np.cos(rz), -np.sin(rz), 0], [np.sin(rz), np.cos(rz), 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def placed(mesh: trimesh.Trimesh, transform: dict) -> trimesh.Trimesh:
    m = mesh.copy()
    m.merge_vertices()
    R = rotation(*transform.get("rotate", [0, 0, 0]))
    t = np.array(transform.get("translate", [0, 0, 0]), dtype=float)
    m.vertices = m.vertices @ R.T + t
    return m


# ---------------------------------------------------------------- geometry

def convex_edges(mesh: trimesh.Trimesh, min_deg: float = 60.0):
    """Return (midpoints, lengths, dihedral_deg) for convex edges above min_deg."""
    n = mesh.face_normals
    c = mesh.triangles_center
    fa = mesh.face_adjacency
    ang = np.degrees(mesh.face_adjacency_angles)
    edges = mesh.face_adjacency_edges
    mid = (mesh.vertices[edges[:, 0]] + mesh.vertices[edges[:, 1]]) / 2
    length = np.linalg.norm(mesh.vertices[edges[:, 0]] - mesh.vertices[edges[:, 1]], axis=1)
    # convex when each neighbour's centre lies behind the other face's plane
    d1 = np.einsum("ij,ij->i", n[fa[:, 0]], c[fa[:, 1]] - c[fa[:, 0]])
    d2 = np.einsum("ij,ij->i", n[fa[:, 1]], c[fa[:, 0]] - c[fa[:, 1]])
    keep = (ang > min_deg) & (d1 < 0) & (d2 < 0)
    return mid[keep], length[keep], ang[keep]


def cluster_points(points: np.ndarray, cell: float):
    """Group points into cubic cells; return (centroids, counts)."""
    if len(points) == 0:
        return np.zeros((0, 3)), np.zeros(0, dtype=int)
    keys = np.floor(points / cell).astype(int)
    uniq, inverse = np.unique(keys, axis=0, return_inverse=True)
    centroids = np.zeros((len(uniq), 3))
    counts = np.bincount(inverse, minlength=len(uniq))
    for i in range(len(uniq)):
        centroids[i] = points[inverse == i].mean(axis=0)
    return centroids, counts


def visibility(scene: trimesh.Trimesh, points: np.ndarray, views: np.ndarray) -> np.ndarray:
    """Fraction of views from which each point is unoccluded."""
    if len(points) == 0:
        return np.zeros(0)
    score = np.zeros(len(points))
    for vp in views:
        d = points - vp
        dist = np.linalg.norm(d, axis=1)
        d = d / dist[:, None]
        loc, ir, _ = scene.ray.intersects_location(np.repeat(vp[None, :], len(points), 0), d, multiple_hits=True)
        if len(ir) == 0:
            score += 1.0
            continue
        dd = np.linalg.norm(loc - vp, axis=1)
        for r in np.unique(ir):
            if dd[ir == r].min() > dist[r] - 1.0:
                score[r] += 1.0
    return score / len(views)


def load_functional(version_dir: str, default_radius: float = 4.0):
    """Declared functional features, as axis/cylinder datums. A blunt cap inside one
    is a functional opening (a knife-edge groove must stay open), not a defect."""
    path = os.path.join(version_dir, "datums.json")
    if not os.path.exists(path):
        return []
    try:
        d = json.load(open(path, encoding="utf-8"))
    except Exception:
        return []
    out = []
    for a in d.get("axes", []):
        out.append({"name": a.get("name", "axis"),
                    "point": np.array(a["point"], float),
                    "dir": np.array(a["dir"], float),
                    "radius": float(default_radius)})
    for c in d.get("cylinders", []):
        out.append({"name": c.get("name", "cylinder"),
                    "point": np.array(c["point"], float),
                    "dir": np.array(c["dir"], float),
                    "radius": float(c.get("radius", default_radius))})
    return out


def exempt_by(cen, functional):
    for f in functional:
        d = f["dir"] / max(np.linalg.norm(f["dir"]), 1e-9)
        v = cen - f["point"]
        perp = v - np.dot(v, d) * d
        if np.linalg.norm(perp) < f["radius"]:
            return f["name"]
    return None


def blunt_caps(mesh: trimesh.Trimesh, functional=(), max_area: float = 40.0,
               normal_tol: float = 0.98, square_tol: float = 10.0):
    """Flat axis-aligned faces whose whole boundary is a 90° corner: a blunt cut."""
    n, c, a = mesh.face_normals, mesh.triangles_center, mesh.area_faces
    fa, ang = mesh.face_adjacency, np.degrees(mesh.face_adjacency_angles)
    # group coplanar faces
    key = np.round(n, 2)
    off = np.round(np.einsum("ij,ij->i", n, c), 2)
    groups: dict[tuple, list[int]] = {}
    for i in range(len(n)):
        groups.setdefault(tuple(key[i]) + (float(off[i]),), []).append(i)
    # neighbour lookup
    adj: dict[int, list[tuple[int, float]]] = {}
    for (f1, f2), ang_ in zip(fa, ang):
        adj.setdefault(f1, []).append((f2, ang_))
        adj.setdefault(f2, []).append((f1, ang_))
    caps = []
    for k, idx in groups.items():
        total = float(a[idx].sum())
        if total > max_area or total <= 0:
            continue
        normal = np.array(k[:3])
        ax = int(np.argmax(np.abs(normal)))
        if abs(normal[ax]) < normal_tol:
            continue
        idx_set = set(idx)
        boundary, square, nbrs = 0.0, 0.0, set()
        for f in idx:
            for nb, ang_ in adj.get(f, []):
                if nb in idx_set:
                    continue
                boundary += 1.0
                if abs(ang_ - 90.0) <= square_tol:
                    square += 1.0
                    nbrs.add(nb)
        if boundary == 0 or square / boundary < 0.9 or not nbrs:
            continue
        cen = (c[idx] * a[idx, None]).sum(0) / total
        # Below the visual feature size: a 0.7 mm scale tick is texture, not a form end.
        cap_pts = np.unique(np.concatenate([mesh.faces[f] for f in idx]))
        cap_v = mesh.vertices[cap_pts] - cen
        u = np.cross(normal, [0.0, 0.0, 1.0])
        if np.linalg.norm(u) < 1e-6:
            u = np.cross(normal, [1.0, 0.0, 0.0])
        u /= np.linalg.norm(u)
        v = np.cross(normal, u)
        span = (float(np.ptp(cap_v @ u)), float(np.ptp(cap_v @ v)))
        if min(span) < MIN_FEATURE_MM:
            continue
        # Is there a slender member behind this cap? Look only inside a tube of
        # radius 1.5x the cap width: outside it lies the rest of the part (a 0.7 mm
        # scale tick sits in front of an 80 mm plate), inside it lies the member.
        width = np.sqrt(max(total, 1e-6))
        rel = mesh.vertices - cen
        lateral = rel - np.outer(rel @ normal, normal)
        tube = np.linalg.norm(lateral, axis=1) < 1.5 * width
        if not tube.any():
            continue
        proj = rel[tube] @ (-normal)
        if float(proj.max()) < 3.0 * width:
            continue
        length = float(proj.max())
        caps.append({"atMm": [round(float(v), 1) for v in cen],
                     "areaMm2": round(total, 1),
                     "memberLengthMm": round(length, 1),
                     "slender": round(length / width, 1),
                     "normal": [round(float(v), 2) for v in normal],
                     "exemptBy": exempt_by(cen, functional)})
    return caps


def silhouette(mesh: trimesh.Trimesh, axes: tuple[int, int], res: float = 0.5):
    """Rasterised orthographic silhouette; returns descriptors."""
    V = mesh.vertices[:, axes]
    mn = V.min(0) - res
    mx = V.max(0) + res
    nx = int(np.ceil((mx[0] - mn[0]) / res)) + 1
    ny = int(np.ceil((mx[1] - mn[1]) / res)) + 1
    mask = np.zeros((ny, nx), bool)
    for tri in V[mesh.faces]:
        p = (tri - mn) / res
        i0, j0 = np.floor(p.min(0)).astype(int)
        i1, j1 = np.ceil(p.max(0)).astype(int)
        i0, j0 = max(i0, 0), max(j0, 0)
        i1, j1 = min(i1, nx - 1), min(j1, ny - 1)
        if i1 < i0 or j1 < j0:
            continue
        xs, ys = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
        pts = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], 1)
        A, B, C = p[0], p[1], p[2]
        v0, v1, v2 = C - A, B - A, pts - A
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-12:
            continue
        u = (v2[:, 0] * v1[1] - v1[0] * v2[:, 1]) / den
        v = (v0[0] * v2[:, 1] - v2[:, 0] * v0[1]) / den
        inside = (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9)
        if inside.any():
            mask[ys.ravel()[inside], xs.ravel()[inside]] = True
    rows = np.where(mask.any(1))[0]
    if len(rows) == 0:
        return {}
    width = np.array([(np.where(mask[r])[0].max() - np.where(mask[r])[0].min() + 1) * res
                      for r in range(rows.min(), rows.max() + 1)])
    z = (mn[1] + np.arange(rows.min(), rows.max() + 1) * res)
    ws = np.convolve(width, np.ones(9) / 9, mode="same")
    waists, _ = find_peaks(-ws, prominence=5.0)
    peaks, _ = find_peaks(ws, prominence=5.0)
    # symmetry about the world centre plane (x=0 / y=0), not the silhouette bbox
    # symmetry: tolerant to 1-pixel offsets (thin rods would otherwise score 0)
    cx = int(round((0 - mn[0]) / res))
    left = mask[:, :cx][:, ::-1]
    right = mask[:, cx:]
    n = min(left.shape[1], right.shape[1])
    L, R = left[:, :n], right[:, :n]
    near = binary_dilation(R, np.ones((3, 3), bool))
    nearL = binary_dilation(L, np.ones((3, 3), bool))
    inter = (L & near).sum() + (R & nearL).sum()
    union = L.sum() + R.sum()
    b = mask.astype(np.int16)
    perim = (np.abs(np.diff(b, axis=0)).sum() + np.abs(np.diff(b, axis=1)).sum()) * res
    area = mask.sum() * res * res
    return {
        "heightMm": round(float(z[-1] - z[0]), 1),
        "widthMaxMm": round(float(width.max()), 1),
        "widthMinMm": round(float(width.min()), 1),
        "baseWidthMm": round(float(width[: max(1, int(0.2 * len(width)))].max()), 1),
        "maxWidthMm": round(float(width.max()), 1),
        "maxWidthAtZMm": round(float(z[int(np.argmax(width))]), 1),
        "maxOverBase": round(float(width.max() / max(width[: max(1, int(0.2 * len(width)))].max(), 1e-6)), 2),
        "waists": [{"zMm": round(float(z[i]), 1), "widthMm": round(float(ws[i]), 1)} for i in waists],
        "peaks": [{"zMm": round(float(z[i]), 1), "widthMm": round(float(ws[i]), 1)} for i in peaks],
        "symmetryMatch": round(float(inter / max(union, 1)), 3),
        "isoperimetric": round(float(4 * np.pi * area / max(perim ** 2, 1e-6)), 3),
    }


# ---------------------------------------------------------------- main

def find_versions_dir(manifest_path: str) -> str:
    """Locate the corpus `versions/` dir. Layouts differ:
    <proj>/assembly/assembly.json + <proj>/cad-data/versions, and
    <proj>/cad-data/assembly/assembly.json + <proj>/cad-data/versions."""
    here = os.path.dirname(os.path.abspath(manifest_path))
    for up in range(0, 4):
        root = os.path.abspath(os.path.join(here, *([".."] * up)))
        for cand in (os.path.join(root, "versions"),
                     os.path.join(root, "cad-data", "versions")):
            if os.path.isdir(cand):
                return cand
    raise SystemExit(f"no versions/ dir found near {manifest_path}")


def analyse(manifest_path: str, cell: float, n_views: int) -> dict:
    manifest = load_manifest(manifest_path)
    root = manifest["root"]
    base_dir = os.path.dirname(find_versions_dir(manifest_path))
    parts = list(walk_parts(root))

    scene, analysed, reference = [], [], []
    role_assumed = 0
    for pid, version, transform, name, node_role, source in parts:
        stl = os.path.join(base_dir, "versions", str(version), "model.stl")
        if not os.path.exists(stl):
            print(f"  ! missing {version} for {pid}", file=sys.stderr)
            continue
        m = placed(trimesh.load(stl, force="mesh"), transform)
        scene.append(m)
        role = node_role or ("purchased" if source == "stock" else None)
        assumed = role is None
        if assumed:
            role = "purchased" if (any(k in name for k in REFERENCE_PART) or
                                   any(k in pid for k in REFERENCE_PART)) else "printed"
            role_assumed += 1
        (reference if role != "printed" else analysed).append((pid, version, name, m, role, assumed))

    if not analysed:
        raise SystemExit("no printed parts found")

    scene_mesh = trimesh.util.concatenate(scene)
    lo, hi = scene_mesh.bounds
    centre = np.array([0, 0, (lo[2] + hi[2]) / 2])
    radius = max(float(np.linalg.norm(hi - lo)), 1.0) * 1.6
    views = []
    for az in range(0, 360, 360 // n_views):
        for el in (12, 55):
            a, e = np.radians(az), np.radians(el)
            views.append(centre + radius * np.array([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)]))
    views = np.array(views)

    findings, attention = [], []
    total_visible = total_hidden = 0.0
    for pid, version, name, m, role, assumed in analysed:
        mid, length, _ = convex_edges(m)
        centroids, counts = cluster_points(mid, cell)
        score = visibility(scene_mesh, centroids, views)
        # cluster length = sum of member edge lengths
        cluster_len = np.zeros(len(centroids))
        keys = np.floor(mid / cell).astype(int) if len(mid) else np.zeros((0, 3), int)
        uniq, inverse = np.unique(keys, axis=0, return_inverse=True) if len(mid) else (np.zeros((0, 3), int), np.zeros(0, int))
        for i in range(len(uniq)):
            cluster_len[i] = length[inverse == i].sum()
        vis = score >= 0.25
        total_visible += float(cluster_len[vis].sum())
        total_hidden += float(cluster_len[~vis].sum())
        findings.append({
            "part": pid, "version": version, "name": name, "role": role, "roleAssumed": assumed,
            "volumeMm3": round(float(m.volume), 1), "areaMm2": round(float(m.area), 1),
            "sharpEdgesMm": round(float(length.sum()), 1),
            "visibleSharpMm": round(float(cluster_len[vis].sum()), 1),
            "hiddenSharpMm": round(float(cluster_len[~vis].sum()), 1),
            "clusters": int(len(centroids)),
            "visibleClusters": int(vis.sum()),
            "topVisible": [
                {"atMm": [round(float(v), 1) for v in centroids[i]],
                 "lenMm": round(float(cluster_len[i]), 1),
                 "visibility": round(float(score[i]), 2)}
                for i in np.argsort(-cluster_len * vis)[:3]
            ],
        })
        functional = load_functional(os.path.join(base_dir, "versions", str(version)))
        all_caps = blunt_caps(m, functional)
        exempted = [c for c in all_caps if c["exemptBy"]]
        caps = sorted([c for c in all_caps if not c["exemptBy"]], key=lambda c: -c["areaMm2"])[:3]
        findings[-1]["exemptCaps"] = len(exempted)
        for cap in caps:
            attention.append({"kind": "termination", "part": pid, "version": version,
                              "atMm": cap["atMm"], "areaMm2": cap["areaMm2"],
                              "memberLengthMm": cap["memberLengthMm"],
                              "slender": cap["slender"],
                              "detail": f"平端面 {cap['areaMm2']} mm²，长细比 {cap['slender']}，边界全为 90° 直角边"})

    for label, axes in (("front", (0, 2)), ("side", (1, 2))):
        sil = silhouette(scene_mesh, axes)
        if sil:
            attention.append({"kind": "silhouette", "view": label, **sil})

    return {
        "schemaVersion": 1,
        "tool": "appearance_probe (read-only prototype)",
        "manifest": manifest_path,
        "assembly": manifest.get("name", ""),
        "parameters": {"cellMm": cell, "views": n_views},
        "parts": {"analysed": len(analysed), "reference": len(reference),
                  "roleAssumed": role_assumed},
        "judgement": {
            "visibleSharpMm": round(total_visible, 1),
            "hiddenSharpMm": round(total_hidden, 1),
            "hiddenShare": round(total_hidden / max(total_visible + total_hidden, 1e-6), 3),
            "volumeMm3": round(sum(f["volumeMm3"] for f in findings), 1),
            "areaMm2": round(sum(f["areaMm2"] for f in findings), 1),
            "visibleSharpPerKmm2": round(total_visible / max(sum(f["areaMm2"] for f in findings) / 1000, 1e-6), 2),
            "exemptCaps": sum(f["exemptCaps"] for f in findings),
            "findings": sorted(findings, key=lambda f: -f["visibleSharpMm"]),
        },
        "attention": {"count": len(attention), "items": attention},
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("--json")
    ap.add_argument("--cell", type=float, default=10.0)
    ap.add_argument("--views", type=int, default=12)
    args = ap.parse_args()

    result = analyse(args.manifest, args.cell, args.views)
    j = result["judgement"]
    print(f"\n{result['assembly']}  —  {result['parts']['analysed']} 件（参考件 {result['parts']['reference']}）")
    print(f"  可见锐边 {j['visibleSharpMm']:.0f} mm   不可见 {j['hiddenSharpMm']:.0f} mm"
          f"（{j['hiddenShare'] * 100:.0f}%）   密度 {j['visibleSharpPerKmm2']:.2f} mm/1000mm²")
    for f in j["findings"][:8]:
        print(f"    {f['part']:<10} {f['version']:<5} 可见 {f['visibleSharpMm']:7.1f} mm"
              f"  簇 {f['visibleClusters']:3d}/{f['clusters']:<3d}  总 {f['sharpEdgesMm']:7.1f} mm")
    kinds: dict[str, int] = {}
    for a in result["attention"]["items"]:
        kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1
    print(f"  注意力项 {result['attention']['count']} 条 {kinds}"
          f"   功能面豁免 {j['exemptCaps']} 条"
          + (f"   role 靠推断 {result['parts']['roleAssumed']} 件" if result['parts']['roleAssumed'] else ""))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        print(f"  → {args.json}")


if __name__ == "__main__":
    main()
