"""探针 4：保形四面体车道（gmsh + scikit-fem）能不能给出**真正的表面 Kt**？

与体素车道（probe-fillet-kt.py）严格同一件：同一个带肩部圆角的台阶试件、同一工况
（x=min 面全约束，x=max 面拉 F=38.4 N，E=3500 MPa，ν=0.35，σ_nom=F/(t·d)=10 MPa），
但网格不再是体素，而是贴合圆角的四面体。

体素车道的已知结论（experiments/20261019_fillet_kt_voxel_fem_probe.md）：边界最大
von Mises 随加密单调发散（2.000→2.440），且对圆角半径完全不敏感——它测的是网格；
工具据此拒绝报表面值。本探针问的是：保形网格能否报出停在某个数上的表面 Kt，
以及为此付多少代价（新依赖 + 网格 + 自由度）。

    .tmp-cad-runtime/venv/bin/python scripts/probe-fillet-tet-kt.py --selftest
    .tmp-cad-runtime/venv/bin/python scripts/probe-fillet-tet-kt.py

gmsh 不在 pinned 运行时里（共享 venv 只读），用 `pip install --no-deps --target`
装到 .tmp-stress/py-gmsh，由本脚本把该目录插进 sys.path；numpy/scipy/skfem 仍用
pinned 版本。几何复用 probe-fillet-kt.py 的 fillet_profile()/make_specimen()。
"""

import importlib.util
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # dsh-cad-harness
OUT_DIR = os.path.join(ROOT, ".tmp-stress")
GMSH_SITE = os.path.join(OUT_DIR, "py-gmsh")      # 本地 --target 安装点

if not os.path.isfile(os.path.join(GMSH_SITE, "gmsh.py")):
    raise SystemExit(f"找不到 gmsh：{GMSH_SITE}")
sys.path.insert(0, GMSH_SITE)

import gmsh  # noqa: E402
from shapely.geometry import Point  # noqa: E402

from skfem import (  # noqa: E402
    Basis, BilinearForm, ElementTetP1, ElementTetP2, ElementVectorH1,
    FacetBasis, LinearForm, MeshTet, asm, condense,
)
from skfem.models.elasticity import lame_parameters, linear_elasticity  # noqa: E402
from skfem.utils import solve as sk_solve  # noqa: E402


def _load_voxel_probe():
    """按路径加载 probe-fillet-kt.py（有 __main__ 保护，import 不跑 main）。"""
    path = os.path.join(HERE, "probe-fillet-kt.py")
    spec = importlib.util.spec_from_file_location("probe_fillet_kt", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


PFK = _load_voxel_probe()

D_WIDE = PFK.D_WIDE            # 6.4
D_NARROW = PFK.D_NARROW        # 3.2
THICK = PFK.THICK              # 1.2
L_WIDE = PFK.L_WIDE            # 4.0
L_NARROW = PFK.L_NARROW        # 8.0
SIGMA_NOM = PFK.SIGMA_NOM      # 10.0 MPa
F_TOTAL = PFK.F                # 38.4 N
E_MOD = 3500.0
NU = 0.35
RADIUS = 0.8


# --------------------------------------------------------------------------
# 小工具：应力
# --------------------------------------------------------------------------
def stress_from_grad(grad, E=E_MOD, nu=NU):
    """grad (3,3,...) → Voigt 应力 (6,...)。"""
    lam, mu = lame_parameters(E, nu)
    eps = 0.5 * (grad + np.transpose(grad, [1, 0] + list(range(2, grad.ndim))))
    tr = eps[0, 0] + eps[1, 1] + eps[2, 2]
    sig = np.empty((6,) + eps.shape[2:])
    for i in range(3):
        sig[i] = lam * tr + 2 * mu * eps[i, i]
    sig[3] = 2 * mu * eps[0, 1]
    sig[4] = 2 * mu * eps[1, 2]
    sig[5] = 2 * mu * eps[0, 2]
    return sig


def vm_from_voigt(sig):
    sxx, syy, szz, sxy, syz, sxz = sig
    return np.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2)
                   + 3.0 * (sxy ** 2 + syz ** 2 + sxz ** 2))


# --------------------------------------------------------------------------
# gmsh → numpy
# --------------------------------------------------------------------------
def _pull_mesh():
    """把 gmsh 当前网格拉成 p (3,N) / T (4,M) + 统计。"""
    ntags, ncoords, _ = gmsh.model.mesh.getNodes()
    ntags = np.asarray(ntags, dtype=np.int64)
    p_all = np.asarray(ncoords, dtype=float).reshape(-1, 3)
    pos = np.full(int(ntags.max()) + 1, -1, dtype=np.int64)
    pos[ntags] = np.arange(len(ntags))
    T = np.zeros((4, 0), dtype=np.int64)
    alltags = []
    for _, tag in gmsh.model.getEntities(3):
        types, etags, nodetags = gmsh.model.mesh.getElements(3, tag=tag)
        for i, (et, en) in enumerate(zip(types, nodetags)):
            if et != 4:
                raise RuntimeError(f"非四面体单元类型 {et}")
            arr = np.asarray(en, dtype=np.int64).reshape(-1, 4)
            T = np.hstack((T, pos[arr.T]))
            alltags.append(np.asarray(etags[i], dtype=np.int64))
    # gmsh 会留下没被任何体单元引用的孤立节点（零行 ⇒ 刚度矩阵奇异）：删掉
    used = np.unique(T)
    remap = np.full(p_all.shape[0], -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    T = remap[T]
    p = p_all[used].T
    n_orphan = int(p_all.shape[0] - len(used))
    # gmsh 的四面体朝向不保证一致：负体积的交换 2/3 号节点
    a = p[:, T[1]] - p[:, T[0]]
    bvec = p[:, T[2]] - p[:, T[0]]
    cvec = p[:, T[3]] - p[:, T[0]]
    v = np.einsum("ij,ij->j", np.cross(a, bvec, axis=0), cvec) / 6.0
    if np.any(np.abs(v) < 1e-12):
        raise RuntimeError("退化四面体（体积 0）")
    flip = v < 0
    tmp = T[2, flip].copy()
    T[2, flip] = T[3, flip]
    T[3, flip] = tmp
    v = np.abs(v)
    h = (6.0 * v) ** (1.0 / 3.0)
    qmin = qmean = None
    try:
        quals = np.asarray(gmsh.model.mesh.getElementQualities(
            np.concatenate(alltags).tolist(), "minSICN"), dtype=float)
        qmin, qmean = float(quals.min()), float(quals.mean())
    except Exception:
        pass
    return p, T, {
        "nodes": int(p.shape[1]), "tets": int(T.shape[1]),
        "hMinMm": float(h.min()), "hMedianMm": float(np.median(h)),
        "hMaxMm": float(h.max()), "volumeMm3": float(v.sum()),
        "minSICN": qmin, "meanSICN": qmean, "orphanNodesDropped": n_orphan,
    }


def _gmsh_logs():
    logs = gmsh.logger.get()
    return {"gmshLogWarn": int(sum(1 for s in logs if "Warning" in s or "Error" in s)),
            "gmshLogSample": [s for s in logs if "Warning" in s or "Error" in s][:3]}


# --------------------------------------------------------------------------
# 求解
# --------------------------------------------------------------------------
def solve_elastic(p, T, fixed_fn, load_fn, traction, order):
    m = MeshTet(p, T)
    elem = ElementVectorH1(ElementTetP1() if order == 1 else ElementTetP2())
    basis = Basis(m, elem)
    K = asm(linear_elasticity(*lame_parameters(E_MOD, NU)), basis)

    fixed = m.facets_satisfying(fixed_fn)
    loaded = m.facets_satisfying(load_fn)
    D = basis.get_dofs(facets=fixed).all()

    fb = FacetBasis(m, elem, facets=loaded)
    tr = np.asarray(traction, dtype=float)

    @LinearForm
    def trac(v, w):
        return tr[0] * v[0] + tr[1] * v[1] + tr[2] * v[2]

    b = asm(trac, fb)

    t0 = time.time()
    u = sk_solve(*condense(K, b, D=D))
    solve_s = time.time() - t0

    comp = basis.split_indices()          # 每个位移分量的 dof 索引
    resid = K @ u - b
    return u, basis, m, {
        "dofs": int(basis.N), "tets": int(T.shape[1]), "nodes": int(p.shape[1]),
        "fixedFacets": int(len(fixed)), "loadedFacets": int(len(loaded)),
        "loadSumN": float(np.sum(b[comp[0]]) + np.sum(b[comp[1]]) + np.sum(b[comp[2]])),
        "loadSumXyzN": [float(np.sum(b[c])) for c in comp],
        "reactionSumN": float(-np.sum(resid[D])),
        "reactionSumXyzN": [float(-np.sum(resid[np.intersect1d(D, c)])) for c in comp],
        "solveSeconds": round(solve_s, 1),
    }


# --------------------------------------------------------------------------
# 悬臂梁自检
# --------------------------------------------------------------------------
def mesh_box(L, h, t, hmax):
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.logger.start()
    gmsh.model.add("beam")
    gmsh.model.occ.addBox(0.0, -h / 2, -t / 2, L, h, t)
    gmsh.model.occ.synchronize()
    gmsh.option.setNumber("Mesh.MeshSizeMax", hmax)
    gmsh.option.setNumber("Mesh.MeshSizeMin", hmax / 4)
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    gmsh.model.mesh.generate(3)
    p, T, stats = _pull_mesh()
    stats.update(_gmsh_logs())
    gmsh.finalize()
    return p, T, stats


def point_basis(m, elem, u, pts):
    """在任意点取值与梯度（每点一个单元素 Basis + 点求积，公共 API）。"""
    pts = np.atleast_2d(np.asarray(pts, dtype=float)).T if np.asarray(pts).ndim == 1 else np.asarray(pts, dtype=float)
    finder = m.element_finder()
    cells = finder(pts[0], pts[1], pts[2])
    mapping = m.mapping()
    out_v = np.empty((3, pts.shape[1]))
    out_g = np.empty((3, 3, pts.shape[1]))
    for i, c in enumerate(cells):
        xr = mapping.invF(pts[:, i:i + 1, None], tind=np.array([c]))[:, :, 0]
        sub = Basis(m, elem, elements=np.array([c]),
                    quadrature=(xr.reshape(3, 1), np.ones(1)))
        f = sub.interpolate(u)
        out_v[:, i] = f.value[:, 0, 0]
        out_g[:, :, i] = f.grad[:, :, 0, 0]
    return out_v, out_g


def selftest(meshes=(0.40, 0.25), F=0.05):
    L, h, t = 30.0, 2.0, 2.0
    I = t * h ** 3 / 12.0
    G = E_MOD / (2 * (1 + NU))
    A = h * t
    d_eb = F * L ** 3 / (3 * E_MOD * I)
    d_ti = d_eb + F * L / (5.0 / 6.0 * G * A)
    rows = []
    for hmax in meshes:
        t0 = time.time()
        p, T, stats = mesh_box(L, h, t, hmax)
        u, basis, m, info = solve_elastic(
            p, T, lambda x: x[0] < 1e-6, lambda x: x[0] > L - 1e-6,
            (0.0, F / (h * t), 0.0), order=2)
        val, _ = point_basis(m, basis.elem, u, np.array([[L - 1e-9], [0.0], [0.0]]))
        uy = float(val[1, 0])
        row = {
            "hMaxMm": hmax, "tets": stats["tets"], "nodes": info["nodes"],
            "dofs": info["dofs"], "minSICN": stats["minSICN"],
            "seconds": round(time.time() - t0, 1), "deltaFEMmm": uy,
            "deltaEulerBernoulliMm": d_eb, "deltaTimoshenkoMm": d_ti,
            "errVsEBPct": 100 * (uy / d_eb - 1),
            "errVsTimoshenkoPct": 100 * (uy / d_ti - 1),
            "loadSumN": info["loadSumN"], "reactionSumN": info["reactionSumN"],
        }
        rows.append(row)
        print(f"  h={hmax:>5} tets={stats['tets']:>6} dofs={info['dofs']:>7} "
              f"δ_FEM={uy:.6f} mm  δ_EB={d_eb:.6f}  err_EB={row['errVsEBPct']:+.2f}%  "
              f"err_Ti={row['errVsTimoshenkoPct']:+.2f}%  ({row['seconds']}s)", flush=True)
    return {"beam": {"L": L, "h": h, "t": t, "F_N": F, "I_mm4": I,
                     "theoryEBmm": d_eb, "theoryTimmoshenkoMm": d_ti},
            "rows": rows}


# --------------------------------------------------------------------------
# 试件：路线 b —— OCC 建真圆弧
# --------------------------------------------------------------------------
SPEC_PTS = [(-L_WIDE, -D_WIDE / 2), (0.0, -D_WIDE / 2),
            (0.0, -(D_NARROW / 2 + RADIUS)), (RADIUS, -D_NARROW / 2),
            (L_NARROW, -D_NARROW / 2), (L_NARROW, D_NARROW / 2),
            (RADIUS, D_NARROW / 2), (0.0, D_NARROW / 2 + RADIUS),
            (0.0, D_WIDE / 2), (-L_WIDE, D_WIDE / 2)]
ARC_CENTERS = {(2, 3): (RADIUS, -(D_NARROW / 2 + RADIUS)),
               (6, 7): (RADIUS, (D_NARROW / 2 + RADIUS))}


def mesh_specimen_occ(level):
    h_fine, h_coarse = level["fine"], level["coarse"]
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.logger.start()
    gmsh.model.add("specimen")
    occ = gmsh.model.occ
    pts = [occ.addPoint(x, y, -THICK / 2.0) for (x, y) in SPEC_PTS]
    curves = []
    for i in range(len(SPEC_PTS)):
        j = (i + 1) % len(SPEC_PTS)
        if (i, j) in ARC_CENTERS:
            cx, cy = ARC_CENTERS[(i, j)]
            ctag = occ.addPoint(cx, cy, -THICK / 2.0)
            curves.append(occ.addCircleArc(pts[i], ctag, pts[j]))
        else:
            curves.append(occ.addLine(pts[i], pts[j]))
    loop = occ.addCurveLoop(curves)
    surf = occ.addPlaneSurface([loop])
    occ.extrude([(2, surf)], 0.0, 0.0, THICK)
    occ.synchronize()

    # 圆角局部细化：两个 Box 场取 Min（VIn 处 h_fine，远处 h_coarse）
    boxes = []
    y_lo, y_hi = D_NARROW / 2 - 0.05, D_NARROW / 2 + RADIUS + 0.15
    for sy in (1.0, -1.0):
        f = gmsh.model.mesh.field.add("Box")
        gmsh.model.mesh.field.setNumber(f, "VIn", h_fine)
        gmsh.model.mesh.field.setNumber(f, "VOut", h_coarse)
        gmsh.model.mesh.field.setNumber(f, "XMin", -0.10)
        gmsh.model.mesh.field.setNumber(f, "XMax", RADIUS + 0.20)
        gmsh.model.mesh.field.setNumber(f, "YMin", sy * y_lo if sy > 0 else -y_hi)
        gmsh.model.mesh.field.setNumber(f, "YMax", y_hi if sy > 0 else -y_lo)
        gmsh.model.mesh.field.setNumber(f, "ZMin", -THICK / 2)
        gmsh.model.mesh.field.setNumber(f, "ZMax", THICK / 2)
        gmsh.model.mesh.field.setNumber(f, "Thickness", 0.30)
        boxes.append(f)
    fmin = gmsh.model.mesh.field.add("Min")
    gmsh.model.mesh.field.setNumbers(fmin, "FieldsList", boxes)
    gmsh.model.mesh.field.setAsBackgroundMesh(fmin)
    gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
    gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
    gmsh.option.setNumber("Mesh.MeshSizeMax", h_coarse)
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    gmsh.model.mesh.generate(3)
    p, T, stats = _pull_mesh()
    stats.update(_gmsh_logs())
    stats["route"] = "occ"
    stats["fineMm"], stats["coarseMm"] = h_fine, h_coarse
    gmsh.finalize()
    return p, T, stats


# --------------------------------------------------------------------------
# 试件：路线 a —— STL 进 gmsh
# --------------------------------------------------------------------------
def mesh_specimen_stl(hmax, fine=None):
    stl = os.path.join(OUT_DIR, f"fillet-r{RADIUS}-tet.stl")
    mesh = PFK.make_specimen(RADIUS)
    mesh.export(stl)
    info = {"route": "stl", "stl": os.path.relpath(stl, ROOT),
            "stlWatertight": bool(mesh.is_watertight),
            "stlFaces": int(len(mesh.faces)), "stlVerts": int(len(mesh.vertices)),
            "stlEuler": int(mesh.euler_number)}
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.logger.start()
    gmsh.model.add("specimen_stl")
    try:
        gmsh.merge(stl)
        gmsh.model.mesh.removeDuplicateNodes()
        n_after_merge = sum(len(x) for x in gmsh.model.mesh.getElements(3)[2])
        info["tetsAfterMergeOnly"] = int(n_after_merge)
        info["gmshSurfacesAfterMerge"] = int(len(gmsh.model.getEntities(2)))
        # 只有离散面，必须先分类/重建几何，才能造 volume
        gmsh.model.mesh.classifySurfaces(math.pi * 40 / 180, True, True, math.pi)
        gmsh.model.mesh.createGeometry()
        info["stlSurfaces"] = int(len(gmsh.model.getEntities(2)))
        info["stlCurves"] = int(len(gmsh.model.getEntities(1)))
        sl = gmsh.model.geo.addSurfaceLoop(
            [e[1] for e in gmsh.model.getEntities(2)])
        gmsh.model.geo.addVolume([sl])
        gmsh.model.geo.synchronize()
        if fine is not None:
            boxes = []
            y_lo, y_hi = D_NARROW / 2 - 0.05, D_NARROW / 2 + RADIUS + 0.15
            fld = gmsh.model.mesh.field
            for sy in (1.0, -1.0):
                f = fld.add("Box")
                fld.setNumber(f, "VIn", fine)
                fld.setNumber(f, "VOut", hmax)
                fld.setNumber(f, "XMin", -0.10)
                fld.setNumber(f, "XMax", RADIUS + 0.20)
                fld.setNumber(f, "YMin", sy * y_lo if sy > 0 else -y_hi)
                fld.setNumber(f, "YMax", y_hi if sy > 0 else -y_lo)
                fld.setNumber(f, "ZMin", -THICK / 2)
                fld.setNumber(f, "ZMax", THICK / 2)
                fld.setNumber(f, "Thickness", 0.30)
                boxes.append(f)
            fm = fld.add("Min")
            fld.setNumbers(fm, "FieldsList", boxes)
            fld.setAsBackgroundMesh(fm)
            gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
            gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
            gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
            info["stlLocalFieldFineMm"] = fine
        gmsh.option.setNumber("Mesh.MeshSizeMax", hmax)
        gmsh.option.setNumber("Mesh.MeshSizeMin", hmax / 4)
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        gmsh.model.mesh.generate(3)
        p, T, stats = _pull_mesh()
    except Exception as exc:
        gmsh.finalize()
        info["failed"] = f"{type(exc).__name__}: {exc}"
        return None, None, info
    stats.update(info)
    stats.update(_gmsh_logs())
    gmsh.finalize()
    return p, T, stats


# --------------------------------------------------------------------------
# 圆角面识别 / 表面与定点应力
# --------------------------------------------------------------------------
def arc_radial_error(p):
    """点到两条圆角母线（R=0.8 圆弧，角度限定在该象限内）的径向偏差。

    下侧圆心 (R, -(d/2+R))：圆弧角度 [90°,180°]；上侧圆心 (R, +(d/2+R))：[-180°,-90°]。
    角度落在扇区外时返回 inf（该点不属于圆角母线）。
    """
    err = np.full(p.shape[1], np.inf)
    eps = 1e-6
    for sy in (1.0, -1.0):
        yc = sy * (D_NARROW / 2 + RADIUS)
        dx = p[0] - RADIUS
        dy = p[1] - yc
        r = np.hypot(dx, dy)
        ang = np.degrees(np.arctan2(dy, dx))
        if sy > 0:
            span = (ang >= -180.0 - eps) & (ang <= -90.0 + eps)
        else:
            span = (ang >= 90.0 - eps) & (ang <= 180.0 + eps)
        near = np.abs(r - RADIUS) < 0.5          # 只在圆角附近才算径向偏差
        err = np.where(span & near, np.minimum(err, np.abs(r - RADIUS)), err)
    return err


def fillet_facets(m, tol=0.06):
    bf = m.boundary_facets()
    c = m.p[:, m.facets[:, bf]].mean(axis=1)
    keep = (arc_radial_error(c) < tol) & (np.abs(c[2]) < THICK / 2 - 1e-9)
    return bf[keep]


def free_surface_facets(m, xmin, xmax, margin=0.0):
    """自由表面 facet：去掉约束面/加载面，margin 再把约束面附近的边缘奇点带剥掉。"""
    bf = m.boundary_facets()
    c = m.p[:, m.facets[:, bf]].mean(axis=1)
    keep = (c[0] > xmin + margin) & (c[0] < xmax - 1e-6)
    return bf[keep]


def facet_stress(m, u, elem, facets):
    fb = FacetBasis(m, elem, facets=facets)
    sig = stress_from_grad(fb.interpolate(u).grad)
    return vm_from_voigt(sig), fb.normals.value, fb.global_coordinates().value, fb


def inward_sign(m, facet, outward):
    poly = PFK.fillet_profile(RADIUS)
    c = m.p[:, m.facets[:, facet]].mean(axis=1)
    for s in (1.0, -1.0):
        q = c[:2] + s * 5e-3 * outward[:2]
        if poly.contains(Point(float(q[0]), float(q[1]))):
            return s
    return -1.0


def fillet_node_radial_error(m):
    """圆角弧面上的网格节点到理想圆弧的径向偏差（只取圆角 facet 的节点）。"""
    ff = fillet_facets(m)
    nodes = np.unique(m.facets[:, ff])
    return arc_radial_error(m.p[:, nodes]), nodes


def arc_points(n=181):
    pts = []
    for sy in (1.0, -1.0):
        yc = sy * (D_NARROW / 2 + RADIUS)
        for a in np.linspace(np.pi / 2, np.pi, n):
            pts.append((RADIUS + RADIUS * np.cos(a), yc + RADIUS * np.sin(a), 0.0))
    return np.array(pts).T


def run_specimen(p, T, stats, order, label):
    xmin, xmax = float(p[0].min()), float(p[0].max())
    trac = (F_TOTAL / (THICK * D_NARROW), 0.0, 0.0)
    u, basis, m, info = solve_elastic(
        p, T, lambda x: x[0] < xmin + 1e-6, lambda x: x[0] > xmax - 1e-6, trac, order)
    elem = basis.elem

    ff = fillet_facets(m)
    fs = free_surface_facets(m, xmin, xmax, margin=0.5)
    fs_raw = free_surface_facets(m, xmin, xmax)
    vm_f, n_f, x_f, _ = facet_stress(m, u, elem, ff)
    vm_s, n_s, x_s, _ = facet_stress(m, u, elem, fs)
    vm_r, _, x_r, _ = facet_stress(m, u, elem, fs_raw)

    i_f = np.unravel_index(np.argmax(vm_f), vm_f.shape)
    i_s = np.unravel_index(np.argmax(vm_s), vm_s.shape)
    hot_f = x_f[:, i_f[0], i_f[1]]
    hot_s = x_s[:, i_s[0], i_s[1]]

    out = {"label": label, "order": order, "route": stats.get("route"),
           "tets": stats["tets"], "nodes": stats["nodes"], "dofs": info["dofs"],
           "hMinMm": stats["hMinMm"], "hMedianMm": stats["hMedianMm"],
           "hMaxMm": stats["hMaxMm"], "minSICN": stats.get("minSICN"),
           "volumeMm3": stats["volumeMm3"],
           "seconds": info["solveSeconds"],
           "loadSumN": info["loadSumN"], "reactionSumN": info["reactionSumN"],
           "filletFacets": int(len(ff)), "freeFacets": int(len(fs)),
           "Kt_fillet": float(vm_f.max() / SIGMA_NOM),
           "Kt_freeSurface": float(vm_s.max() / SIGMA_NOM),
           "Kt_freeSurfaceRaw": float(vm_r.max() / SIGMA_NOM),
           "hotspotRawMm": [round(float(v), 4) for v in
                            x_r[:, *np.unravel_index(np.argmax(vm_r), vm_r.shape)]],
           "vmFilletFaceMaxMPa": float(vm_f.max()),
           "hotspotFilletMm": [round(float(v), 4) for v in hot_f],
           "hotspotFreeMm": [round(float(v), 4) for v in hot_s]}

    # d_c = 0.2 mm：自由面最大值点沿内法向退 0.2 mm（与体素车道的声明距离同口径）
    outw = n_s[:, i_s[0], i_s[1]]
    s_in = inward_sign(m, fs[i_s[1]], outw)
    out["declaredDistanceMm"] = 0.2
    for tag, pt in (("inward", hot_s + s_in * 0.2 * outw),
                    ("outward", hot_s - s_in * 0.2 * outw),
                    ("inward0.19", hot_s + s_in * 0.19 * outw)):
        try:
            _, g = point_basis(m, elem, u, pt.reshape(3, 1))
            out["Kt_at_declared_distance"] = float(vm_from_voigt(stress_from_grad(g))[0] / SIGMA_NOM)
            out["declaredProbeMm"] = [round(float(x), 4) for x in pt]
            out["declaredProbeMode"] = tag
            break
        except Exception as exc:
            out["Kt_at_declared_distance"] = None
            out["declaredError"] = f"{tag}: {type(exc).__name__}: {exc}"

    # 圆角弧面 0.2 mm 深度一圈
    ap = arc_points()
    poly = PFK.fillet_profile(RADIUS)
    depth = []
    for k in range(ap.shape[1]):
        q = ap[:, k]
        rad = np.array([q[0] - RADIUS, q[1] - (D_NARROW / 2 + RADIUS) * np.sign(q[1]), 0.0])
        rad /= np.linalg.norm(rad)
        for s in (1.0, -1.0):
            cand = q + s * 0.2 * rad
            if poly.contains(Point(float(cand[0]), float(cand[1]))):
                depth.append(cand)
                break
    depth = np.array(depth).T
    _, g = point_basis(m, elem, u, depth)
    vmd = vm_from_voigt(stress_from_grad(g))
    out["arcDepth02"] = {"points": int(depth.shape[1]),
                         "maxMPa": float(vmd.max()),
                         "medianMPa": float(np.median(vmd)),
                         "KtMax": float(vmd.max() / SIGMA_NOM),
                         "KtMedian": float(np.median(vmd) / SIGMA_NOM)}
    return out


def voxel_reference(dx=0.10, dcs=(0.2, 0.3)):
    """体素车道的同口径读数（同一 STL、同一工况、同一 σ_nom），用于对拍。"""
    sys.path.insert(0, os.path.join(ROOT, "python", "cad_worker"))
    import stress_fem
    stl = os.path.join(OUT_DIR, f"fillet-r{RADIUS}-tet.stl")
    if not os.path.isfile(stl):
        PFK.make_specimen(RADIUS).export(stl)
    out = {}
    for dc in dcs:
        res = stress_fem.run({
            "path": stl, "dxMm": dx,
            "youngModulusMPa": E_MOD, "poissonRatio": NU, "yieldMPa": 25.0,
            "fixedFaces": [{"axis": "x", "side": "min"}],
            "loads": [{"face": {"axis": "x", "side": "max"},
                       "forceN": [F_TOTAL, 0.0, 0.0]}],
            "criticalDistanceMm": dc,
            "runConvergence": False,
        })
        out[f"dc{dc}"] = {
            "dxMm": dx,
            "criticalDistanceMmMm": res.get("criticalDistanceMm"),
            "solidCells": res.get("solidCells"),
            "Kt_boundaryMax": round(res["maxVonMisesBoundaryMPa"] / SIGMA_NOM, 4),
            "Kt_at_declared_distance": round(res["peakDeclaredDepthMPa"] / SIGMA_NOM, 4),
            "peakDeclaredDepthAtMm": res.get("peakDeclaredDepthAtMm"),
            "equilibriumErrorPct": res.get("equilibriumErrorPct"),
        }
    return out



# --------------------------------------------------------------------------
# 独立对照：同一剖面的二维平面应力（不同维度/不同单元，用于交叉验证 Kt）
# --------------------------------------------------------------------------
def mesh_profile_2d(fine, coarse):
    """同一剖面的二维三角形网格（OCC 真圆弧 + 同样的 Box 尺寸场）。"""
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.model.add("profile")
    occ = gmsh.model.occ
    pts = [occ.addPoint(x, y, 0.0) for (x, y) in SPEC_PTS]
    curves = []
    for i in range(len(SPEC_PTS)):
        j = (i + 1) % len(SPEC_PTS)
        if (i, j) in ARC_CENTERS:
            cx, cy = ARC_CENTERS[(i, j)]
            ctag = occ.addPoint(cx, cy, 0.0)
            curves.append(occ.addCircleArc(pts[i], ctag, pts[j]))
        else:
            curves.append(occ.addLine(pts[i], pts[j]))
    surf = occ.addPlaneSurface([occ.addCurveLoop(curves)])
    occ.synchronize()
    fld = gmsh.model.mesh.field
    boxes = []
    y_lo, y_hi = D_NARROW / 2 - 0.05, D_NARROW / 2 + RADIUS + 0.15
    for sy in (1.0, -1.0):
        f = fld.add("Box")
        fld.setNumber(f, "VIn", fine)
        fld.setNumber(f, "VOut", coarse)
        fld.setNumber(f, "XMin", -0.10)
        fld.setNumber(f, "XMax", RADIUS + 0.20)
        fld.setNumber(f, "YMin", sy * y_lo if sy > 0 else -y_hi)
        fld.setNumber(f, "YMax", y_hi if sy > 0 else -y_lo)
        fld.setNumber(f, "Thickness", 0.30)
        boxes.append(f)
    fm = fld.add("Min")
    fld.setNumbers(fm, "FieldsList", boxes)
    fld.setAsBackgroundMesh(fm)
    gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
    gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
    gmsh.option.setNumber("Mesh.MeshSizeMax", coarse)
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    gmsh.model.mesh.generate(2)
    ntags, ncoords, _ = gmsh.model.mesh.getNodes()
    ntags = np.asarray(ntags, dtype=np.int64)
    p2 = np.asarray(ncoords, dtype=float).reshape(-1, 3)[:, :2]
    pos = np.full(int(ntags.max()) + 1, -1, dtype=np.int64)
    pos[ntags] = np.arange(len(ntags))
    types, etags, nodetags = gmsh.model.mesh.getElements(2)
    T = np.hstack([pos[np.asarray(en, dtype=np.int64).reshape(-1, 3).T]
                   for et, en in zip(types, nodetags) if et == 2])
    used = np.unique(T)
    remap = np.full(p2.shape[0], -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    p2, T = p2[used].T, remap[T]
    a = p2[:, T[1]] - p2[:, T[0]]
    bb = p2[:, T[2]] - p2[:, T[0]]
    v = 0.5 * np.abs(a[0] * bb[1] - a[1] * bb[0])
    gmsh.finalize()
    return p2, T, {"nodes": int(p2.shape[1]), "tris": int(T.shape[1]),
                   "areaMm2": float(v.sum())}


def plane_stress_kt(levels=(("h", 0.100, 0.40), ("h/1.6", 0.0625, 0.25)), order=2):
    """平面应力（厚度 THICK）下的表面 Kt；与三维结果互为独立对照。"""
    from skfem import ElementTriP1, ElementTriP2, MeshTri
    # 平面应力本构（Voigt: xx, yy, xy）
    Cps = E_MOD / (1 - NU ** 2) * np.array([[1.0, NU, 0.0],
                                            [NU, 1.0, 0.0],
                                            [0.0, 0.0, (1 - NU) / 2]])

    @BilinearForm
    def ps(u, v, w):
        exx, eyy = u.grad[0][0], u.grad[1][1]
        exy = 0.5 * (u.grad[0][1] + u.grad[1][0])
        gxx, gyy = v.grad[0][0], v.grad[1][1]
        gxy = 0.5 * (v.grad[0][1] + v.grad[1][0])
        return THICK * (Cps[0, 0] * exx * gxx + Cps[0, 1] * (exx * gyy + eyy * gxx)
                        + Cps[1, 1] * eyy * gyy + Cps[2, 2] * 2.0 * exy * 2.0 * gxy)

    rows = []
    for name, fine, coarse in levels:
        p2, T, st = mesh_profile_2d(fine, coarse)
        m = MeshTri(p2, T)
        elem = ElementVectorH1(ElementTriP1() if order == 1 else ElementTriP2())
        basis = Basis(m, elem)
        K = asm(ps, basis)
        xmin, xmax = float(p2[0].min()), float(p2[0].max())
        fixed = m.facets_satisfying(lambda x: x[0] < xmin + 1e-6)
        loaded = m.facets_satisfying(lambda x: x[0] > xmax - 1e-6)
        D = basis.get_dofs(facets=fixed).all()
        fb = FacetBasis(m, elem, facets=loaded)
        tr = np.array([F_TOTAL / (THICK * D_NARROW), 0.0])

        @LinearForm
        def trac(v, w):
            return THICK * (tr[0] * v[0] + tr[1] * v[1])   # 乘以厚度 ⇒ 总力 38.4 N

        b = asm(trac, fb)
        u = sk_solve(*condense(K, b, D=D))

        bf = m.boundary_facets()
        c = p2[:, m.facets[:, bf]].mean(axis=1)
        ff = bf[arc_radial_error(np.vstack((c, np.zeros(c.shape[1])))) < 0.06]
        fbf = FacetBasis(m, elem, facets=ff)
        g = fbf.interpolate(u).grad
        exx, eyy = g[0, 0], g[1, 1]
        exy = 0.5 * (g[0, 1] + g[1, 0])
        sxx = Cps[0, 0] * exx + Cps[0, 1] * eyy
        syy = Cps[1, 0] * exx + Cps[1, 1] * eyy
        sxy = Cps[2, 2] * exy
        vm = np.sqrt(sxx ** 2 - sxx * syy + syy ** 2 + 3 * sxy ** 2)
        j = np.unravel_index(np.argmax(vm), vm.shape)
        xy = fbf.global_coordinates().value
        mx, mn = float(np.sum(b[basis.split_indices()[0]])), float(
            -np.sum((K @ u - b)[D]))
        rows.append({"label": f"2d-{name}", "order": order, "tris": st["tris"],
                     "dofs": int(basis.N), "Kt": float(vm.max() / SIGMA_NOM),
                     "loadSumN": mx, "reactionSumN": mn,
                     "hotspotMm": [round(float(xy[0, j[0], j[1]]), 4),
                                   round(float(xy[1, j[0], j[1]]), 4)]})
        print(f"  2D 平面应力 {name}: tris={st['tris']} dofs={basis.N} "
              f"Kt={rows[-1]['Kt']:.4f} 热点={rows[-1]['hotspotMm']} "
              f"平衡 {mn:.2f}N", flush=True)
    return rows


# --------------------------------------------------------------------------
LEVELS = [{"name": "h", "fine": 0.100, "coarse": 0.40},
          {"name": "h/1.6", "fine": 0.0625, "coarse": 0.25}]


def table(rows):
    head = ("| 路线/网格 | 阶 | 四面体 | 自由度 | h_min–h_max (mm) | Kt_自由面 | "
            "Kt_圆角面 | Kt@0.2mm | 求解 |\n|---|---|---|---|---|---|---|---|---|\n")
    body = []
    for r in rows:
        d = r["Kt_at_declared_distance"]
        body.append(
            f"| {r['label']} | P{r['order']} | {r['tets']} | {r['dofs']} | "
            f"{r['hMinMm']:.3f}–{r['hMaxMm']:.3f} | {r['Kt_freeSurface']:.3f} | "
            f"{r['Kt_fillet']:.3f} | {('—' if d is None else f'{d:.3f}')} | "
            f"{r['seconds']}s |")
    return head + "\n".join(body)


def version_probe():
    import skfem
    return {"gmsh": None, "skfem": skfem.__version__}


def write_merged(result):
    """把本次结果并进已有 JSON（--selftest/--planestress 只更新自己那部分）。"""
    out = os.path.join(OUT_DIR, "probe-fillet-tet-kt.json")
    if os.path.isfile(out):
        with open(out, encoding="utf-8") as fh:
            old = json.load(fh)
        for k, v in result.items():
            if v is None or v == [] or v == {}:
                continue                     # 不要用空值覆盖已有结果
            old[k] = v
        result = old
    write(result)
    return result


def write(result):
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "probe-fillet-tet-kt.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1, ensure_ascii=False)
    print(f"\n→ {out}")


def main():
    gmsh.initialize()
    gmsh_ver = gmsh.option.getString("General.Version")
    gmsh.finalize()
    result = {"gmshVersion": gmsh_ver, "skfemVersion": version_probe()["skfem"],
              "sigmaNomMPa": SIGMA_NOM, "F_N": F_TOTAL, "E": E_MOD, "nu": NU,
              "radiusMm": RADIUS,
              "specimen": {"D": D_WIDE, "d": D_NARROW, "t": THICK,
                           "L": L_WIDE + L_NARROW},
              "rows": [], "routes": {}, "cantilever": None}
    print(f"gmsh {gmsh_ver} | skfem {result['skfemVersion']} | "
          f"σ_nom={SIGMA_NOM} MPa | F={F_TOTAL} N | r={RADIUS} mm\n")

    if "--planestress" in sys.argv:
        print("== 独立对照：同一剖面的二维平面应力（P2，两档网格）==")
        rows2 = plane_stress_kt()
        result["planeStress2D"] = rows2
        if len(rows2) >= 2:
            d = 100 * (rows2[-1]["Kt"] - rows2[-2]["Kt"]) / rows2[-2]["Kt"]
            result["planeStress2DConvergencePct"] = d
            print(f"  两档变化：{rows2[-2]['Kt']:.4f}→{rows2[-1]['Kt']:.4f} ({d:+.2f}%)")
        write_merged(result)
        return 0

    if "--selftest" in sys.argv:
        print("== 悬臂梁自检（30×2×2 mm，末端 y 向力 F=0.05 N，P2）==")
        result["cantilever"] = selftest()
        write_merged(result)
        for r in result["cantilever"]["rows"]:
            print(f"  判定：{'OK' if abs(r['errVsEBPct']) < 1.0 else '超差'}"
                  f"（EB 误差 {r['errVsEBPct']:+.2f}%）")
        return 0

    print("== 路线 a：STL 进 gmsh ==")
    p_a, T_a, st_a = mesh_specimen_stl(LEVELS[0]["coarse"], fine=LEVELS[0]["fine"])
    if T_a is not None:
        print(f"  merge 后四面体={st_a.get('tetsAfterMergeOnly')}，"
              f"classifySurfaces+createGeometry 后 {st_a['stlSurfaces']} 面/{st_a['stlCurves']} 线；"
              f"最终 tets={st_a['tets']} h=[{st_a['hMinMm']:.3f},{st_a['hMaxMm']:.3f}]")
        err_a, nodes_a = fillet_node_radial_error(MeshTet(p_a, T_a))
        fin = np.isfinite(err_a)
        result["routes"]["stl"] = dict(st_a)
        result["routes"]["stl"]["nodeRadiusErrMaxMm"] = float(err_a[fin].max())
        result["routes"]["stl"]["nodeRadiusErrMedianMm"] = float(np.median(err_a[fin]))
        result["routes"]["stl"]["nodesOnArc"] = int(len(nodes_a))
        result["routes"]["stl"]["nodesNotOnArcSpan"] = int((~fin).sum())
        ra = run_specimen(p_a, T_a, st_a, 2, "stl-h-P2")
        result["rows"].append(ra)
        print(f"  Kt_圆角面={ra['Kt_fillet']:.3f} Kt_自由面={ra['Kt_freeSurface']:.3f} "
              f"| 弧面节点径向误差 max={result['routes']['stl']['nodeRadiusErrMaxMm']:.4f} "
              f"median={result['routes']['stl']['nodeRadiusErrMedianMm']:.4f} mm")
    else:
        print(f"  失败：{st_a.get('failed')}")
        result["routes"]["stl"] = st_a

    print("\n== 路线 b：OCC 真圆弧 + Box 尺寸场 ==")
    for level in LEVELS:
        t0 = time.time()
        p, T, stats = mesh_specimen_occ(level)
        meshing = time.time() - t0
        print(f"  {level['name']} (fine={level['fine']}, coarse={level['coarse']}): "
              f"tets={stats['tets']} nodes={stats['nodes']} "
              f"h=[{stats['hMinMm']:.4f},{stats['hMaxMm']:.4f}] "
              f"minSICN={stats['minSICN'] if stats['minSICN'] is not None else float('nan'):.3f} "
              f"warn={stats['gmshLogWarn']} "
              f"({meshing:.1f}s)", flush=True)
        result["routes"][level["name"]] = dict(stats, meshSeconds=round(meshing, 1))
        for order in (1, 2):
            r = run_specimen(p, T, stats, order, f"occ-{level['name']}-P{order}")
            r["fineMm"], r["coarseMm"] = level["fine"], level["coarse"]
            r["meshSeconds"] = round(meshing, 1)
            result["rows"].append(r)
            print(f"    P{order}: dofs={r['dofs']:>7} Kt_圆角面={r['Kt_fillet']:.3f} "
                  f"Kt_自由面={r['Kt_freeSurface']:.3f} Kt@0.2mm={r['Kt_at_declared_distance']} "
                  f"弧面0.2mm(max)={r['arcDepth02']['KtMax']:.3f} "
                  f"热区={r['hotspotFreeMm']} ({r['seconds']}s)", flush=True)

    print("\n== 收敛性（OCC，两档网格；h→h/1.6）==")
    result["convergence"] = {}
    for order in (1, 2):
        s = sorted([r for r in result["rows"]
                    if r["order"] == order and r["route"] == "occ"], key=lambda r: r["tets"])
        if len(s) >= 2:
            a, b = s[-2], s[-1]
            d1 = 100 * (b["Kt_fillet"] - a["Kt_fillet"]) / a["Kt_fillet"]
            d2 = 100 * (b["Kt_freeSurface"] - a["Kt_freeSurface"]) / a["Kt_freeSurface"]
            d3 = (100 * (b["Kt_at_declared_distance"] - a["Kt_at_declared_distance"])
                  / a["Kt_at_declared_distance"]
                  if a["Kt_at_declared_distance"] and b["Kt_at_declared_distance"] else float("nan"))
            da = a["Kt_at_declared_distance"]
            db = b["Kt_at_declared_distance"]
            tail = (f"Kt@0.2mm {da:.4f}→{db:.4f} ({d3:+.2f}%)"
                    if da and db else f"Kt@0.2mm {da}→{db}")
            print(f"  P{order}: Kt_圆角面 {a['Kt_fillet']:.4f}→{b['Kt_fillet']:.4f} ({d1:+.2f}%) | "
                  f"Kt_自由面 {a['Kt_freeSurface']:.4f}→{b['Kt_freeSurface']:.4f} ({d2:+.2f}%) | "
                  + tail)
            result["convergence"][f"P{order}"] = {
                "KtFillet": [a["Kt_fillet"], b["Kt_fillet"]], "dFilletPct": d1,
                "KtFree": [a["Kt_freeSurface"], b["Kt_freeSurface"]], "dFreePct": d2,
                "KtDeclared": [a["Kt_at_declared_distance"], b["Kt_at_declared_distance"]],
                "dDeclaredPct": None if d3 != d3 else d3}

    print("\n== 体素车道同口径读数（同一 STL，criticalDistanceMm 可调）==")
    try:
        result["voxel"] = voxel_reference()
        for k, v in result["voxel"].items():
            print(f"  {k}: dx={v['dxMm']} cells={v['solidCells']} "
                  f"Kt_boundaryMax={v['Kt_boundaryMax']} "
                  f"Kt@d_c={v['Kt_at_declared_distance']} "
                  f"(声明距离实测 {v['criticalDistanceMmMm']}mm, 位置 {v['peakDeclaredDepthAtMm']})")
    except Exception as exc:
        result["voxel"] = {"failed": f"{type(exc).__name__}: {exc}"}
        print(f"  失败：{result['voxel']['failed']}")

    result["table"] = table(result["rows"])
    print("\n" + result["table"])
    write(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
