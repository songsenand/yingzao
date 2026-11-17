#!/usr/bin/env python3
"""Quick STL sanity report: bbox, signed volume, triangle count, edge manifoldness.

Binary STL, numpy only (the pinned CAD runtime has numpy). Edge manifoldness is a
coarse check: every undirected edge must be shared by exactly two triangles.
"""
import struct
import sys
from collections import Counter

import numpy as np


def load(path):
    with open(path, "rb") as f:
        f.read(80)
        (n,) = struct.unpack("<I", f.read(4))
        data = np.frombuffer(f.read(n * 50), dtype=np.uint8).reshape(n, 50)
    tri = data[:, 12:48].copy().view("<f4").reshape(n, 3, 3).astype(np.float64)
    return tri


def report(path):
    tri = load(path)
    v = tri.reshape(-1, 3)
    bbox = np.vstack([v.min(0), v.max(0)])
    # signed volume via divergence theorem
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    vol = np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0
    # edge manifoldness on quantised vertices
    q = np.round(v, 4)
    idx = {tuple(p): i for i, p in enumerate(q)}
    faces = np.array([[idx[tuple(p)] for p in t] for t in q.reshape(-1, 3, 3)])
    edges = Counter()
    for f in faces:
        for i in range(3):
            e = tuple(sorted((f[i], f[(i + 1) % 3])))
            edges[e] += 1
    bad = sum(1 for c in edges.values() if c != 2)
    print(f"{path.split('/')[-1]:16s} tris={len(tri):7d} vol={vol/1000:9.2f} cm3 "
          f"bbox=({bbox[0][0]:.1f},{bbox[0][1]:.1f},{bbox[0][2]:.1f}).."
          f"({bbox[1][0]:.1f},{bbox[1][1]:.1f},{bbox[1][2]:.1f}) "
          f"nonmanifold_edges={bad}")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        report(p)
