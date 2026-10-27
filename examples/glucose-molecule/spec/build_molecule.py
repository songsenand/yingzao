#!/usr/bin/env python3
"""β-D-吡喃葡萄糖球棍模型的几何真值（唯一真源）。

产出 spec/molecule.json：原子中心、键对、每个零件实例的位姿（Euler XYZ，mm/z-up），
以及每个零件在自身坐标系里的 socket/peg 锚点。CAD 零件的 SCAD 代码、
assembly/assembly.json、以及装配检查都从这个文件读参数，不手抄坐标。

几何约定（与 spec/design.md 的参数表一一对应）：
  * 环 = 理想椅式六元环，键长 L 全等、键角全为四面体角 109.47° → 环**精确闭合**。
  * 环外键长按真实键长比例缩放（C-C 22 / C-O 20 / C-H 18 / O-H 17），
    环外键长的取值不影响环闭合。
  * 每个原子的 socket 方向 = 指向其成键伙伴的单位向量。
  * 零件局部坐标：C 的 4 个 socket 为四面体方向 s0..s3；O 的 2 个 socket 为
    t0=+Z、t1=109.47°(XZ 面)；H 的 1 个 socket 为 +Z；键棒轴为 +Z，两端 peg 沿 ∓Z。

运行： run_python script=spec/build_molecule.py  （或 python3，仅需 numpy）
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------- 参数（唯一真源）
L = 22.0                     # 环键中心距（C-C 与 C-O 统一，理想等长环）
RING_N = 6
RADII = {"C": 8.6, "O": 8.0, "H": 6.0}          # 球半径 mm
BOND = {                     # 环外键中心距 mm
    "CC": 22.0,
    "CO_ring": 22.0,
    "CO_oh": 20.0,
    "CH": 18.0,
    "OH": 17.0,
}
ENGAGE = 3.2                 # 单端插接深度（peg 有效长）
SEAT = 0.9                  # 定心平台距球面切点的深度
SOCKET_DEPTH = 3.4          # 自平台起的盲孔深（含 0.2 端隙）
SNAP_BEAD_R = 2.70
SNAP_THROAT_R = 2.60
SNAP_GROOVE_R = 2.95
TET = math.degrees(math.acos(-1.0 / 3.0))      # 109.4712°

_A = math.sqrt(2.0 / 3.0)      # 0.8164966
_B = math.sqrt(2.0) / 3.0      # 0.4714045
TETRA = np.array([
    [0.0, 0.0, 1.0],
    [0.0, 2.0 * _B, -1.0 / 3.0],
    [_A, -_B, -1.0 / 3.0],
    [-_A, -_B, -1.0 / 3.0],
])  # s0..s3，两两点积 -1/3

O_LOCAL = np.array([
    [0.0, 0.0, 1.0],
    [math.sin(math.radians(TET)), 0.0, math.cos(math.radians(TET))],
])  # t0, t1

H_LOCAL = np.array([[0.0, 0.0, 1.0]])


# ---------------------------------------------------------------- 小工具
def unit(v) -> np.ndarray:
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    assert n > 1e-12, "零向量"
    return v / n


def rot_from_pairs(local: np.ndarray, world: np.ndarray) -> np.ndarray:
    """正交 Procrustes：求 R 使 R·local_i ≈ world_i（列向量拼成的帧）。"""
    El = np.column_stack(_gram_schmidt(local))
    Ew = np.column_stack(_gram_schmidt(world))
    return Ew @ El.T


def _gram_schmidt(vecs: np.ndarray) -> list[np.ndarray]:
    """把 1~2 个方向补成正交右手三轴（补轴用叉积），返回 3 个单位向量。"""
    basis: list[np.ndarray] = []
    for v in list(vecs)[:3]:   # 3 轴已定帧；多出来的方向由旋转一致性保证
        w = np.asarray(v, dtype=float).copy()
        for b in basis:
            w -= np.dot(w, b) * b
        n = np.linalg.norm(w)
        assert n > 1e-9, "向量线性相关，无法建帧"
        basis.append(w / n)
    while len(basis) < 3:
        if len(basis) == 1:
            seed = np.array([1.0, 0.0, 0.0]) if abs(basis[0][0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        else:
            seed = np.cross(basis[0], basis[1])
        w = seed.copy()
        for b in basis:
            w -= np.dot(w, b) * b
        basis.append(w / np.linalg.norm(w))
    return basis


def euler_xyz(R: np.ndarray) -> list[float]:
    """R = Rz(c)·Ry(b)·Rx(a)（OpenSCAD / Manifold 的 rotate 约定），返回 [a,b,c] 度。"""
    sy = -R[2, 0]
    sy = max(-1.0, min(1.0, sy))
    b = math.asin(sy)
    if abs(math.cos(b)) > 1e-8:
        a = math.atan2(R[2, 1], R[2, 2])
        c = math.atan2(R[1, 0], R[0, 0])
    else:  # gimbal lock
        a = math.atan2(-R[1, 2], R[1, 1])
        c = 0.0
    return [math.degrees(a), math.degrees(b), math.degrees(c)]


def R_zyx(e) -> np.ndarray:
    a, b, c = (math.radians(x) for x in e)
    Rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    Ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
    Rz = np.array([[math.cos(c), -math.sin(c), 0], [math.sin(c), math.cos(c), 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def minimal_rot(a, b) -> np.ndarray:
    """把单位向量 a 转到 b 的最小旋转。"""
    a = unit(a)
    b = unit(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-12:
        if c > 0:
            return np.eye(3)
        # 180°：绕任一垂直轴
        perp = np.cross(a, [1.0, 0.0, 0.0])
        if np.linalg.norm(perp) < 1e-9:
            perp = np.cross(a, [0.0, 1.0, 0.0])
        return axang(unit(perp), math.pi)
    return axang(unit(v), math.acos(max(-1.0, min(1.0, c))))


def axang(axis: np.ndarray, ang: float) -> np.ndarray:
    x, y, z = axis
    K = np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]])
    return np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * (K @ K)


def perp_basis(w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    e1 = np.cross(w, [0.0, 0.0, 1.0])
    if np.linalg.norm(e1) < 1e-8:
        e1 = np.cross(w, [1.0, 0.0, 0.0])
    e1 = unit(e1)
    return e1, np.cross(w, e1)


# ---------------------------------------------------------------- 椅式环
def chair_positions() -> list[np.ndarray]:
    """理想椅式：全等键长 L、每个环内角 == 四面体角，精确闭合。"""
    r = L * math.sqrt(8.0 / 9.0)
    h = L / 6.0
    return [np.array([r * math.cos(math.radians(60 * k)),
                      r * math.sin(math.radians(60 * k)),
                      h * ((-1) ** k)]) for k in range(RING_N)]


def ring_frames(pos: list[np.ndarray]) -> list[dict]:
    """每个环原子的：两个环内键方向、轴向取代方向、平伏取代方向。"""
    out = []
    for k in range(RING_N):
        prev = pos[(k - 1) % RING_N]
        nxt = pos[(k + 1) % RING_N]
        u_prev = unit(prev - pos[k])
        u_next = unit(nxt - pos[k])
        s_hat = unit(u_prev + u_next)
        m = unit(np.cross(u_prev, u_next))
        d1 = -s_hat / math.sqrt(3.0) + math.sqrt(2.0 / 3.0) * m
        d2 = -s_hat / math.sqrt(3.0) - math.sqrt(2.0 / 3.0) * m
        # 轴向 = 更接近 ±Z 的那个
        if abs(d1[2]) > abs(d2[2]):
            axial, eq = unit(d1), unit(d2)
        else:
            axial, eq = unit(d2), unit(d1)
        out.append({"u_prev": u_prev, "u_next": u_next,
                    "axial": axial, "equatorial": eq,
                    "ring_angle": math.degrees(math.acos(np.clip(np.dot(u_prev, u_next), -1, 1)))})
    return out


# ---------------------------------------------------------------- 搭分子
def build() -> dict:
    pos = chair_positions()
    frames = ring_frames(pos)

    atoms: dict[str, dict] = {}

    def add_atom(aid: str, element: str, name: str, p: np.ndarray) -> None:
        atoms[aid] = {"id": aid, "element": element, "name": name, "pos": list(map(float, p))}

    ring_ids = ["O5", "C1", "C2", "C3", "C4", "C5"]
    ring_names = {"O5": "环氧原子 O5", "C1": "碳1", "C2": "碳2", "C3": "碳3",
                  "C4": "碳4", "C5": "碳5"}
    for k, aid in enumerate(ring_ids):
        add_atom(aid, aid[0], ring_names[aid], pos[k])

    centroid = np.mean(pos, axis=0)

    def away_dir(p: np.ndarray) -> np.ndarray:
        return unit(p - centroid)

    # --- 羟基氧 O1..O4 与其氢；碳上的氢 H1..H5
    for k, cid in enumerate(["C1", "C2", "C3", "C4"], start=1):
        oid = f"O{k}"
        hid = f"HO{k}"
        opos = pos[k] + BOND["CO_oh"] * frames[k]["equatorial"]
        add_atom(oid, "O", f"羟基氧 O{k}", opos)
        # O—H：与 O→C 成 109.47°，朝远离环心一侧
        w = unit(pos[k] - opos)                       # O→C
        e1, _ = perp_basis(w)
        t = away_dir(opos) - np.dot(away_dir(opos), w) * w
        if np.linalg.norm(t) < 1e-9:
            t = e1
        t = unit(t)
        d_oh = -w / 3.0 + math.sqrt(8.0 / 9.0) * t
        hpos = opos + BOND["OH"] * unit(d_oh)
        add_atom(hid, "H", f"羟基氢 HO{k}", hpos)
        # 碳上的氢（轴向）
        cid_h = f"H{k}"
        add_atom(cid_h, "H", f"碳上氢 H{k}", pos[k] + BOND["CH"] * frames[k]["axial"])

    # --- C6 (CH2OH) 挂在 C5 的平伏方向
    c6 = pos[5] + BOND["CC"] * frames[5]["equatorial"]
    add_atom("C6", "C", "碳6 CH2OH", c6)
    u0 = unit(pos[5] - c6)                            # C6→C5
    e1, e2 = perp_basis(u0)
    t = away_dir(c6) - np.dot(away_dir(c6), u0) * u0
    if np.linalg.norm(t) < 1e-9:
        t = e1
    t = unit(t)
    e_away = t
    e_side = unit(np.cross(u0, e_away))
    # 三个：O6 取 φ=0（朝外），两个 H 取 ±120°
    phi_o = 0.0
    dirs6 = {}
    for tag, phi in (("O6", phi_o), ("H6a", phi_o + 2 * math.pi / 3), ("H6b", phi_o + 4 * math.pi / 3)):
        dirs6[tag] = unit(-u0 / 3.0 + math.sqrt(8.0 / 9.0) *
                          (math.cos(phi) * e_away + math.sin(phi) * e_side))
    o6 = c6 + BOND["CO_oh"] * dirs6["O6"]
    add_atom("O6", "O", "羟基氧 O6", o6)
    add_atom("H6a", "H", "C6 上氢 a", c6 + BOND["CH"] * dirs6["H6a"])
    add_atom("H6b", "H", "C6 上氢 b", c6 + BOND["CH"] * dirs6["H6b"])
    # O6—H
    w = unit(c6 - o6)
    e1, _ = perp_basis(w)
    t6 = away_dir(o6) - np.dot(away_dir(o6), w) * w
    t6 = unit(t6 if np.linalg.norm(t6) > 1e-9 else e1)
    ho6 = o6 + BOND["OH"] * unit(-w / 3.0 + math.sqrt(8.0 / 9.0) * t6)
    add_atom("HO6", "H", "O6 上氢", ho6)

    # C5 上的轴向氢
    add_atom("H5", "H", "碳上氢 H5", pos[5] + BOND["CH"] * frames[5]["axial"])

    # --- 键表
    bonds: list[dict] = []

    def add_bond(i: str, j: str, kind: str) -> None:
        pi, pj = np.array(atoms[i]["pos"]), np.array(atoms[j]["pos"])
        d = float(np.linalg.norm(pj - pi))
        bonds.append({"id": f"B{len(bonds) + 1:02d}", "i": i, "j": j, "kind": kind,
                      "length": round(d, 4)})

    for k in range(RING_N):
        a, b = ring_ids[k], ring_ids[(k + 1) % RING_N]
        kind = "CO_ring" if "O5" in (a, b) else "CC"
        add_bond(a, b, kind)
    add_bond("C5", "C6", "CC")
    for k in range(1, 5):
        add_bond(f"C{k}", f"O{k}", "CO_oh")
        add_bond(f"O{k}", f"HO{k}", "OH")
        add_bond(f"C{k}", f"H{k}", "CH")
    add_bond("C6", "O6", "CO_oh")
    add_bond("O6", "HO6", "OH")
    add_bond("C6", "H6a", "CH")
    add_bond("C6", "H6b", "CH")
    add_bond("C5", "H5", "CH")

    # --- 每个原子的 socket（指向伙伴）+ 位姿
    for a in atoms.values():
        a["sockets"] = []
    sockets_of: dict[str, list[str]] = {aid: [] for aid in atoms}
    for b in bonds:
        sockets_of[b["i"]].append(b["j"])
        sockets_of[b["j"]].append(b["i"])

    local_sets = {"C": TETRA, "O": O_LOCAL, "H": H_LOCAL}

    for aid, a in atoms.items():
        partners = sockets_of[aid]
        p = np.array(a["pos"])
        world_dirs = [unit(np.array(atoms[q]["pos"]) - p) for q in partners]
        loc = local_sets[a["element"]]
        # 分配：world[k]（第 k 个伙伴）↔ 局部 socket perm[k]。
        # 四面体两点交换会翻手性，故枚举排列，取行列式为正的那个。
        import itertools
        perm = None
        for cand in itertools.permutations(range(len(loc)), len(partners)):
            cl = np.array(cand)
            Rc = rot_from_pairs(loc[cl], np.array(world_dirs))
            err = max(float(np.linalg.norm(Rc @ loc[cl[k]] - world_dirs[k]))
                      for k in range(len(partners)))
            if np.linalg.det(Rc) > 0.9 and err < 1e-6:
                perm = list(cand)
                R = Rc
                break
        assert perm is not None, f"{aid} 找不到旋转解（手性不匹配）"
        a["part"] = f"atom_{a['element']}"
        a["rot"] = euler_xyz(R)
        a["socket_map"] = [
            {"local": f"sock{perm[k]}",
             "partner": partners[k],
             "world_dir": [round(float(x), 6) for x in world_dirs[k]]}
            for k in range(len(partners))
        ]
        # 自检：R 作用在局部 socket 上应等于 world_dir
        for k in range(len(partners)):
            got = R @ loc[perm[k]]
            want = world_dirs[k]
            assert np.linalg.norm(got - want) < 1e-9, f"{aid} socket{k} 旋转不一致"

    # --- 键棒位姿
    for b in bonds:
        pi, pj = np.array(atoms[b["i"]]["pos"]), np.array(atoms[b["j"]]["pos"])
        u = unit(pj - pi)
        Rs = minimal_rot([0.0, 0.0, 1.0], u)
        ri, rj = RADII[atoms[b["i"]]["element"]], RADII[atoms[b["j"]]["element"]]
        # 棍长度 = 两个台肩面间距（定心平台到定心平台）
        b["stick_len"] = round(b["length"] - ri - rj + 2 * SEAT, 4)
        # 位姿：-Z 端台肩面落在 i 球的定心平台上，中心再沿 u 走半根棍
        center = pi + u * ((ri - SEAT) + b["stick_len"] / 2.0)
        b["mid"] = [round(float(x), 6) for x in center]
        b["rot"] = euler_xyz(Rs)
        b["dir"] = [round(float(x), 6) for x in u]
        b["stick_part"] = f"stick_{b['kind']}_{b['stick_len']:.1f}"
        b["atom_i"] = b["i"]
        b["atom_j"] = b["j"]
        del b["i"], b["j"]

    # --- 自检：非键合原子不碰撞、环角、键长
    problems: list[str] = []
    bonded = {(b["atom_i"], b["atom_j"]) for b in bonds} | {(b["atom_j"], b["atom_i"]) for b in bonds}
    ids = list(atoms)
    for ii in range(len(ids)):
        for jj in range(ii + 1, len(ids)):
            x, y = ids[ii], ids[jj]
            d = float(np.linalg.norm(np.array(atoms[x]["pos"]) - np.array(atoms[y]["pos"])))
            gap = d - RADII[atoms[x]["element"]] - RADII[atoms[y]["element"]]
            if (x, y) in bonded:
                continue
            if gap < 0.5:
                problems.append(f"非键合近碰 {x}-{y}: 球面间距 {gap:.2f}mm")
    for k, f in enumerate(frames):
        if abs(f["ring_angle"] - TET) > 1e-6:
            problems.append(f"环角 {ring_ids[k]} = {f['ring_angle']:.4f}°")

    # 环闭合残差：把 6 个中心首尾相接的弦长全部一致 → 0
    closure = max(abs(b["length"] - L) for b in bonds if b["kind"] in ("CC", "CO_ring") and
                  (b["atom_i"] in ring_ids and b["atom_j"] in ring_ids))

    xs = np.array([a["pos"] for a in atoms.values()])
    bbox = {"min": [round(float(v), 2) for v in xs.min(axis=0)],
            "max": [round(float(v), 2) for v in xs.max(axis=0)]}
    bbox["size"] = [round(float(xs.max(axis=0)[i] - xs.min(axis=0)[i]), 2) for i in range(3)]

    # 零件汇总
    from collections import Counter
    part_count = Counter(a["part"] for a in atoms.values())
    stick_count: Counter = Counter()
    for b in bonds:
        stick_count[b["stick_part"]] += 1

    return {
        "params": {"L": L, "RADII": RADII, "BOND": BOND, "ENGAGE": ENGAGE, "SEAT": SEAT,
                   "SOCKET_DEPTH": SOCKET_DEPTH, "SNAP_BEAD_R": SNAP_BEAD_R,
                   "SNAP_THROAT_R": SNAP_THROAT_R, "SNAP_GROOVE_R": SNAP_GROOVE_R,
                   "TET_DEG": round(TET, 4)},
        "local_frames": {"C": TETRA.tolist(), "O": O_LOCAL.tolist(), "H": H_LOCAL.tolist()},
        "atoms": list(atoms.values()),
        "bonds": bonds,
        "bbox_mm": bbox,
        "counts": {"atoms": len(atoms), "bonds": len(bonds),
                   "atom_parts": dict(part_count), "stick_parts": dict(stick_count)},
        "ring_closure_residual_mm": round(closure, 6),
        "problems": problems,
    }


if __name__ == "__main__":
    out = build()
    here = Path(__file__).resolve().parent
    (here / "molecule.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({"counts": out["counts"], "bbox_mm": out["bbox_mm"],
                      "ring_closure_residual_mm": out["ring_closure_residual_mm"],
                      "problems": out["problems"],
                      "first_atom": out["atoms"][0],
                      "first_bond": out["bonds"][0]}, ensure_ascii=False, indent=1))
