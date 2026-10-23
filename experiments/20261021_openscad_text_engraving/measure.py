#!/usr/bin/env python3
"""Minimal binary/ascii STL inspector: volume, bbox, watertightness, radius."""
import re
import struct
import sys

import numpy as np

def load(path):
    data = open(path, 'rb').read()
    if data[:5] == b'solid' and len(data) % 50 != 0:
        txt = data.decode('ascii', 'replace')
        nums = re.findall(r'vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)', txt)
        return np.array(nums, dtype=np.float64).reshape(-1, 3, 3)
    n = struct.unpack('<I', data[80:84])[0]
    rec = np.frombuffer(data[84:84 + n*50], dtype=np.uint8).reshape(n, 50)
    tri = rec[:, 12:48].copy().view('<f4').reshape(n, 3, 3).astype(np.float64)
    return tri

def main(path):
    t = load(path)
    v0, v1, v2 = t[:,0], t[:,1], t[:,2]
    vol = np.einsum('ij,ij->i', v0, np.cross(v1, v2)).sum() / 6.0
    pts = t.reshape(-1, 3)
    mn, mx = pts.min(0), pts.max(0)
    # weld vertices, then every undirected edge must appear exactly twice
    q = np.round(pts, 5)
    _, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.reshape(-1, 3)
    e = np.sort(np.concatenate([inv[:, [0,1]], inv[:, [1,2]], inv[:, [2,0]]]), axis=1)
    _, counts = np.unique(e, axis=0, return_counts=True)
    bad = int((counts != 2).sum())
    # radius about +Z axis, and about the Y axis (for wrapped-cylinder checks)
    r_z = np.hypot(pts[:,0], pts[:,1])
    print(f"file       : {path}")
    print(f"triangles  : {len(t)}")
    print(f"volume     : {vol:.3f} mm^3")
    print(f"bbox       : x[{mn[0]:.2f},{mx[0]:.2f}] y[{mn[1]:.2f},{mx[1]:.2f}] z[{mn[2]:.2f},{mx[2]:.2f}]")
    print(f"radius +Z  : min {r_z.min():.4f}  max {r_z.max():.4f}")
    print(f"edges != 2 : {bad}  ({'WATERTIGHT' if bad == 0 else 'NOT WATERTIGHT'})")
    return 0 if bad == 0 else 1

if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
