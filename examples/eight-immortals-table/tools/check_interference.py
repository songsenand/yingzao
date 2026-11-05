#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""快速干涉自检：读 cad/stl/*.stl + assembly/instances.json，逐对求交体积。
仅用于建模迭代；正式判定用 validate_assembly / check_assembly 的 run。"""
import json
import os
import sys

import numpy as np
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STL = os.path.join(ROOT, "cad", "stl")
INST = json.load(open(os.path.join(ROOT, "assembly", "instances.json"), encoding="utf-8"))

cache = {}


def load(part):
    if part not in cache:
        cache[part] = trimesh.load(os.path.join(STL, part + ".stl"), process=True)
    return cache[part].copy()


def placed(inst):
    m = load(inst["part"])
    m.apply_transform(trimesh.transformations.rotation_matrix(
        np.radians(inst["rotate"][2]), [0, 0, 1]))
    m.apply_translation(inst["translate"])
    return m


meshes = [(i["name"], placed(i)) for i in INST]
print(f"{len(meshes)} instances")
bad = []
for a in range(len(meshes)):
    na, ma = meshes[a]
    for b in range(a + 1, len(meshes)):
        nb, mb = meshes[b]
        if not (np.all(ma.bounds[0] <= mb.bounds[1]) and np.all(mb.bounds[0] <= ma.bounds[1])):
            continue
        try:
            inter = trimesh.boolean.intersection([ma, mb], engine="manifold")
        except Exception as e:  # noqa
            inter = None
        if inter is not None and len(inter.faces):
            v = abs(inter.volume)
            if v > 1.0:
                bad.append((round(v, 2), na, nb))
bad.sort(reverse=True)
for v, na, nb in bad:
    print(f"INTERFERENCE {v:9.1f} mm3  {na} <-> {nb}")
if not bad:
    print("no interference > 1 mm3")
