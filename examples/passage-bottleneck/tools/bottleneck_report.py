#!/usr/bin/env python
"""通道瓶颈：两种采样策略的对照 + 图。

问题（本目录 README 的背景）：一条通道"最窄处有多宽"，可以用
**切一刀 → 求这一刀里空隙截面的最大内切圆（MIC）→ 沿通道取最小** 来测。
要花掉 N 刀，有两种花法：

  A 单方向多刀：刀口法向固定在通道轴上，N 个等距站位各切一刀。
  B 多方向少刀：先稀疏几刀定位通道中轴（各刀 MIC 的圆心连起来），
                再沿中轴取几个站位，每个站位**换若干角度**各切一刀。

本脚本在同一批**已知答案**的零件上把两者跑出来，并画出三种关键图：
  - 采样密度：沿轴等距切 N 刀，能不能切到那段 2mm 的短颈；
  - 朝向：把刀口角度从 0° 转到 90°，MIC 会怎样（棱柱通道上换角度买到什么）；
  - 擦切：刀口几乎贴着壁面时，MIC 会掉到真值以下（假报窄）以及"没有面"≠"半径 0"。

运行：
    .tmp-measure-runtime/venv/bin/python examples/passage-bottleneck/tools/bottleneck_report.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import shapely
import trimesh
from shapely.geometry import LineString
from shapely.ops import polygonize, unary_union

HERE = Path(__file__).resolve().parent.parent          # examples/passage-bottleneck
PARTS = HERE / "parts"
FIGURES = HERE / "figures"

# 每个夹具：SCAD、自然通道轴（设计上已知）、真值瓶颈半径（解析）
FIXTURES = [
    ("01-through-slot", (0.0, 1.0, 0.0), 3.000, "棱柱方槽 6x6"),
    ("02-neck", (0.0, 1.0, 0.0), 1.250, "Ø8 直孔里的 2mm 短颈 Ø2.5"),
    ("03-tilted-bore", (0.5, 0.8660254, 0.0), 4.000, "Ø8 通孔，轴与 y 成 30°"),
    ("04-thin-gap", (0.0, 1.0, 0.0), 0.250, "10 x 0.5mm 贯通窄缝"),
    ("05-blind-pocket", (0.0, 0.0, 1.0), None, "Ø8 深 6mm 盲孔（盲特征）"),
    ("06-sealed-cavity", (0.0, 0.0, 1.0), 0.000, "r=5 完全封死的球腔（拓扑判 0）"),
    ("07-imported-oval-neck", (0.0, 0.0, 1.0), 1.000, "外来件：只有 STL，椭圆颈 2.4x2.0"),
    ("08-blind-cone", (0.0, 0.0, 1.0), None, "锥底盲孔（末端连续收到 0）"),
    ("09-l-slot", (0.0, 0.0, 1.0), 3.750, "L 形贯通槽（开口环非凸）"),
]


# --------------------------------------------------------------------------- 基础


def compile_scad(name: str, out_dir: Path) -> Path:
    """SCAD → STL（零件源码是本目录的唯一事实源，脚本不另建几何）。

    二进制按插件的解析顺序取：仓库自带的 2026.x（manifold 后端）优先，其次系统 openscad。
    """
    scad = PARTS / f"{name}.scad"
    stl = out_dir / f"{name}.stl"
    bundled = HERE.parent.parent / "bin" / "squashfs-root" / "usr" / "bin" / "openscad"
    binaries = [str(bundled)] if bundled.exists() else []
    binaries.append("openscad")
    last = ""
    for binary in binaries:
        for extra in ([], ["--backend=manifold"]):
            proc = subprocess.run([binary, *extra, "-o", str(stl), str(scad)],
                                  capture_output=True, text=True, timeout=300)
            if proc.returncode == 0 and stl.exists():
                return stl
            last = proc.stderr
    raise RuntimeError(f"openscad failed for {scad}:\n{last[-2000:]}")


def fixture_mesh(name: str, out_dir: Path):
    """夹具 → mesh。

    两种来源，**测量路径完全相同**：
      * 有 `.scad` 源码 → 编译成 STL 再量（本目录的 01–06、08）；
      * 只有 `.stl`（外来件/第三方件）→ 直接量（07）。
    这条分支本身就是验收项：真实的排粉/排液与刀具可达性问题大多发生在**没有源码**的件上。
    """
    scad = PARTS / f"{name}.scad"
    if scad.exists():
        return trimesh.load(compile_scad(name, out_dir), process=True), "scad"
    raw = PARTS / f"{name}.stl"
    if raw.exists():
        return trimesh.load(raw, process=True), "stl"
    raise FileNotFoundError(f"no .scad or .stl for fixture {name}")


def plane_basis(normal: np.ndarray):
    seed = np.array([0.0, 0.0, 1.0]) if abs(normal[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(normal, seed)
    u /= np.linalg.norm(u)
    return u, np.cross(normal, u)


def void_region(mesh, normal, at_mm, origin_hint=None):
    """一张切片里的**空隙区域**；这一刀没有空隙时返回 None（注意：不是"半径 0"）。

    构造分三步，每一步都有理由：

    1. 切割是精确的：`trimesh.intersections.mesh_plane`；
    2. 把线段闭合成面：shapely `polygonize`。它不知道环的哪一侧是材料，所以每个面
       用面内一点做实体内外测试来分类（与插件里 `measure_section` 的 `is_material`
       同一手法，用 `representative_point` 而不是质心——环面的质心会落进自己的孔里）；
    3. **空隙 = 包围材料截面的凸包 − 材料**。为什么不直接取"被判为空隙的那些面"：
       `polygonize` 只交出闭合的面，当空隙截面与零件外轮廓**相连**时（扁缝被正切一刀
       就是这样），那个面会整个丢掉，代码会静默地报告"没有空隙"。实测：10x0.5 的扁缝，
       正切一刀只回两个面积 100 的材料面，200 的那块空隙面不见了。
       用"凸包 − 材料"就不依赖面是否闭合。

    代价：截面外轮廓若是凹的，凹处会被算进空隙。这一侧是**安全**的——多出来的面积
    只会把该刀的内切圆**抬高**，而取最小值只会漏报，不会假报窄。
    """
    n = np.asarray(normal, dtype=float)
    n = n / np.linalg.norm(n)
    origin = n * at_mm if origin_hint is None else np.asarray(origin_hint, dtype=float)
    u, v = plane_basis(n)
    segments = trimesh.intersections.mesh_plane(mesh, n, origin)
    if len(segments) == 0:
        return None, (u, v, origin)
    flat = np.asarray(segments, dtype=float).reshape(-1, 3) - origin
    uv = np.round(np.column_stack([flat @ u, flat @ v]).reshape(-1, 2, 2), 6)
    material = []
    for candidate in polygonize(unary_union([LineString(s) for s in uv])):
        point = np.asarray(candidate.representative_point().coords, dtype=float)[0]
        world = origin + u * point[0] + v * point[1]
        if bool(mesh.contains(world.reshape(1, 3))[0]):
            material.append(candidate)
    if not material:
        return None, (u, v, origin)
    solid_section = unary_union(material)
    hull = solid_section.convex_hull
    void = hull.difference(solid_section)
    if void.is_empty:
        return None, (u, v, origin)
    # 「这一刀必须是横切」的可执行形式：空隙截面必须是材料里的一个**内孔**，
    # 不能碰到截面外轮廓。碰到外轮廓只有两种情形：
    #   (a) 刀口已经切出零件之外（靠近包围盒两端时只切到一个角）——那里的"空隙"
    #       是个尖角薄片，内切圆可以任意小，会**假报窄**；
    #   (b) 刀口与通道轴平行（例如顺着扁缝切）——它不把通道两端分开，
    #       按前面的不等式，它的数不支撑任何结论。
    # 实测：不加这一条，Ø8 斜孔（真值 4.0）在两端被切成 0.178mm。
    if void.boundary.distance(hull.boundary) <= 1e-3:
        return None, (u, v, origin)
    return void, (u, v, origin)


def mic_of(geom):
    """空隙区域的**最大内切圆**半径；没有空隙时返回 None。

    切成多块时取**各块的最大值**——不是面积最大的那块。最大内切圆只能落在其中一块里，
    按面积挑块会把"大而扁"的一块当成答案，从而**低报**（实测：斜孔上低报到 0.178mm）。
    """
    if geom is None or geom.is_empty:
        return None, None
    parts = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
    best = None
    for part in parts:
        if part.geom_type != "Polygon" or part.area <= 0:
            continue
        line = shapely.maximum_inscribed_circle(part, 1e-4)
        radius = float(shapely.length(line))
        if best is None or radius > best[0]:
            best = (radius, (part, np.asarray(line.coords, dtype=float)[0]))
    return best if best is not None else (None, None)


def cut(mesh, normal, at_mm, origin_hint=None):
    geom, frame = void_region(mesh, normal, at_mm, origin_hint)
    radius, extra = mic_of(geom)
    return radius, extra


def extent_along(mesh, axis) -> tuple[float, float]:
    bounds = np.asarray(mesh.bounds, dtype=float)
    corners = np.array([[bounds[b][i] for i, b in enumerate(bits)]
                        for bits in __import__("itertools").product((0, 1), repeat=3)])
    projections = corners @ axis
    return float(projections.min()), float(projections.max())


def sweep(mesh, axis, stations: int):
    """方案 A：法向固定 = 通道轴，等距 N 刀。返回 [(站位, MIC 或 None)]。"""
    axis = np.asarray(axis, dtype=float)
    axis = axis / np.linalg.norm(axis)
    low, high = extent_along(mesh, axis)
    out = []
    for at in np.linspace(low, high, stations + 2)[1:-1]:
        radius, _ = cut(mesh, axis, float(at))
        out.append((float(at), radius))
    return out


def topology(mesh):
    """第 0 步：**先判有没有路**——壳数与总亏格。

    这是"先确认联通"的精确判据，而且**不需要体素**：闭合可定向的单壳曲面满足
    欧拉数 = 2 − 2g，所以 `g = (2 − euler)/2` 就是该壳上的**独立隧道条数**。
      * 壳数 ≥ 2  ⇒ 有封闭内腔（与 S2-a 的负体积壳一致），那些腔**没有开口**；
      * 总亏格 0  ⇒ 表面只有凹坑/盲孔，**没有一条通路**；
      * 总亏格 n  ⇒ 有 n 条独立隧道，才轮到"量宽度"。

    实测 8 个夹具：4 个贯通件 + 外来件 = 1 壳 / 亏格 1；平底盲孔与锥底盲孔 = 1 壳 / 亏格 0；
    封死腔 = 2 壳 / 亏格 0。**先判拓扑，再谈宽度**——盲特征根本没有"两端"，量出来的数是死胡同。
    """
    shells = mesh.split(only_watertight=False)
    genus = [int(round((2.0 - shell.euler_number) / 2.0)) for shell in shells]
    return len(shells), genus, int(sum(genus))


# --------------------------------------------------------------------------- 两种花法


def strategy_stations(mesh, axis, budget: int):
    """A 单方向多刀：全部预算花在站位上。"""
    profile = sweep(mesh, axis, budget)
    solid = [r for _, r in profile if r is not None]
    return (min(solid) if solid else None), profile


def strategy_orientations(mesh, axis, budget: int, per_station: int, tilt_deg: float = 20.0):
    """B 多方向少刀：先稀疏几刀定位中轴，再沿中轴换方向切。

    第一步（定轴）：沿给定轴稀疏切 `coarse` 刀，取每刀 MIC 的**圆心**，连成中轴折线；
    第二步：沿这条折线取 `stations` 个站位，法向取该处的**局部切向**，并在 ±`tilt_deg`
    的锥内换成 `per_station` 个方向各切一刀；取全局最小。

    刀数预算：`coarse + stations × per_station ≈ budget`（下面的表里报告实际刀数）。
    """
    axis = np.asarray(axis, dtype=float)
    axis = axis / np.linalg.norm(axis)
    coarse = max(2, budget // 8)
    base = sweep(mesh, axis, coarse)
    centres = []
    for at, radius in base:
        if radius is None:
            continue
        geom, (u, v, origin) = void_region(mesh, axis, at)
        _, extra = mic_of(geom)
        if extra is not None:
            point = np.asarray(extra[1], dtype=float)
            centres.append(origin + u * point[0] + v * point[1])
    spent = len(base)
    if len(centres) < 2:                     # 定不出轴：退回给定轴
        centres = [axis * at for at, _ in base] or [np.zeros(3)]
    centres = np.asarray(centres, dtype=float)
    segments = np.linalg.norm(np.diff(centres, axis=0), axis=1)
    arc = np.concatenate([[0.0], np.cumsum(segments)])
    stations = max(1, (budget - spent) // per_station)
    u, v = plane_basis(axis)
    best = None
    for index in range(stations):
        target = (index + 0.5) / stations * arc[-1]
        j = int(np.clip(np.searchsorted(arc, target) - 1, 0, len(centres) - 2))
        here = centres[j] + (centres[j + 1] - centres[j]) * (
            (target - arc[j]) / max(1e-9, arc[j + 1] - arc[j]))
        tangent = centres[j + 1] - centres[j]
        tangent = tangent / max(1e-9, np.linalg.norm(tangent))
        for k in range(per_station):
            angle = np.radians(tilt_deg) * (k / max(1, per_station - 1)) if per_station > 1 else 0.0
            azimuth = 2 * np.pi * k / max(1, per_station)
            normal = tangent * np.cos(angle) + (u * np.cos(azimuth) + v * np.sin(azimuth)) * np.sin(angle)
            radius, _ = cut(mesh, normal, 0.0, origin_hint=here)
            spent += 1
            if radius is not None and (best is None or radius < best):
                best = radius
    return best, {"cuts": spent, "stations": stations, "centres": len(centres)}


def strategy_adaptive(mesh, axis, budget: int):
    """C 自适应：粗扫一轮，再在每对相邻站位的较小者之间二分细化。"""
    axis = np.asarray(axis, dtype=float)
    axis = axis / np.linalg.norm(axis)
    low, high = extent_along(mesh, axis)
    stations = np.linspace(low, high, max(3, budget // 8) + 2)[1:-1]
    profile = [(float(at), cut(mesh, axis, float(at))[0]) for at in stations]
    spent = len(profile)
    while spent < budget and len(profile) >= 2:
        order = sorted(range(len(profile)), key=lambda i: (profile[i][1] is None, profile[i][1]))
        i = order[0]
        j = i + 1 if i + 1 < len(profile) else i - 1
        left, right = sorted((profile[i][0], profile[j][0]))
        if right - left < 1e-3:
            break
        mid = (left + right) / 2
        radius = cut(mesh, axis, float(mid))[0]
        profile.append((float(mid), radius))
        profile.sort(key=lambda item: item[0])
        spent += 1
    solid = [r for _, r in profile if r is not None]
    return (min(solid) if solid else None), profile


# --------------------------------------------------------------------------- 画图


class Svg:
    """够用的 SVG 生成器（本机有 rsvg-convert，直接把 SVG 转 PNG）。"""

    def __init__(self, width, height):
        self.width, self.height = width, height
        self.body: list[str] = []

    def line(self, x1, y1, x2, y2, stroke="#333333", width=1.0, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.body.append(f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" '
                         f'stroke="{stroke}" stroke-width="{width}"{d}/>')

    def circle(self, cx, cy, r, stroke="#111111", fill="none", width=1.0):
        self.body.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" stroke="{stroke}" '
                         f'fill="{fill}" stroke-width="{width}"/>')

    def poly(self, points, stroke="#333333", fill="none", width=1.0, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in points)
        self.body.append(f'<polygon points="{pts}" stroke="{stroke}" fill="{fill}" '
                         f'stroke-width="{width}"{d}/>')

    def polyline(self, points, stroke="#c0392b", width=1.6):
        pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in points)
        self.body.append(f'<polyline points="{pts}" stroke="{stroke}" fill="none" stroke-width="{width}"/>')

    def text(self, x, y, s, size=13, anchor="start", fill="#111111", weight="normal", rotate=None):
        rot = f' transform="rotate({rotate} {x:.2f} {y:.2f})"' if rotate is not None else ""
        self.body.append(f'<text x="{x:.2f}" y="{y:.2f}" font-family="DejaVu Sans, sans-serif" '
                         f'font-size="{size}" text-anchor="{anchor}" fill="{fill}" '
                         f'font-weight="{weight}"{rot}>{s}</text>')

    def rect(self, x, y, w, h, fill="#f5f5f5", stroke="#bbbbbb"):
        self.body.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" '
                         f'fill="{fill}" stroke="{stroke}"/>')

    def save(self, path: Path):
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" '
               f'viewBox="0 0 {self.width} {self.height}"><rect width="100%" height="100%" fill="white"/>'
               + "".join(self.body) + "</svg>")
        path.write_text(svg, encoding="utf-8")
        png = path.with_suffix(".png")
        subprocess.run(["rsvg-convert", "-w", str(self.width), "-o", str(png), str(path)], check=True)
        return png


def axes(svg, box, xlabel, ylabel, xrange, yrange, xfmt="{:.0f}", yfmt="{:.2f}"):
    x0, y0, w, h = box
    svg.rect(x0, y0, w, h)
    for k in range(6):
        gy = y0 + h * k / 5
        svg.line(x0, gy, x0 + w, gy, "#eeeeee", 1)
        svg.text(x0 - 6, gy + 4, yfmt.format(yrange[1] - (yrange[1] - yrange[0]) * k / 5),
                 size=11, anchor="end")
    for k in range(6):
        gx = x0 + w * k / 5
        svg.text(gx, y0 + h + 16, xfmt.format(xrange[0] + (xrange[1] - xrange[0]) * k / 5),
                 size=11, anchor="middle")
    if xlabel:
        svg.text(x0 + w / 2, y0 + h + 38, xlabel, size=12, anchor="middle")
    svg.text(x0 - 34, y0 + h / 2, ylabel, size=12, anchor="middle", rotate=-90)


def map_xy(box, xrange, yrange, x, y):
    x0, y0, w, h = box
    px = x0 + w * (x - xrange[0]) / (xrange[1] - xrange[0])
    py = y0 + h * (1 - (y - yrange[0]) / (yrange[1] - yrange[0]))
    return px, py


# --------------------------------------------------------------------------- 主流程


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="passage-bottleneck-"))
    FIGURES.mkdir(parents=True, exist_ok=True)
    meshes = {}
    try:
        print("### 夹具（真值来自零件源码注释里的解析值）")
        for name, axis, truth, note in FIXTURES:
            mesh, source = fixture_mesh(name, tmp)
            meshes[name] = mesh
            print(f"  {name:<22} [{source}] {note:<32} "
                  f"真值 B = {truth if truth is not None else '（盲特征）'}")

        print("\n### A/B/C 三种花法，预算都是 100 刀")
        print(f"  {'夹具':<22} {'真值':>7} {'A 单方向100刀':>13} {'B 多方向100刀':>13} {'C 自适应100刀':>13}")
        rows = {}
        for name, axis, truth, note in FIXTURES:
            mesh = meshes[name]
            a, _ = strategy_stations(mesh, axis, 100)
            b, info_b = strategy_orientations(mesh, axis, 100, per_station=10)
            c, _ = strategy_adaptive(mesh, axis, 100)
            rows[name] = (truth, a, b, c)
            fmt = lambda v: "  (无面)" if v is None else f"{v:7.3f}"
            print(f"  {name:<22} {('%.3f' % truth) if truth is not None else '   -- ':>7} "
                  f"{fmt(a):>13} {fmt(b):>13} {fmt(c):>13}"
                  + (f"   B 实刀 {info_b['cuts']}" if abs(info_b['cuts'] - 100) > 12 else ""))

        # ---- 第 0 步：拓扑先判 ----
        print("\n### 第 0 步：先判有没有路（表面拓扑，不用体素、不受分辨率影响）")
        print(f"  {'夹具':<24} {'壳数':>4} {'亏格':>5}  读法")
        for name, axis, truth, note in FIXTURES:
            shells, genus, total = topology(meshes[name])
            if shells >= 2:
                verdict = f"{shells - 1} 个封闭内腔 ⇒ 通道尺寸 = 0（S2-a 的负体积壳）"
            elif total == 0:
                verdict = "0 条隧道 ⇒ 只有盲特征/凹坑，没有通路 ⇒ 未判定，不量宽度"
            else:
                verdict = f"{total} 条隧道 ⇒ 有通路，才轮到量宽度"
            print(f"  {name:<24} {shells:>4} {total:>5}  {verdict}")

        # ---- 预算曲线：同样 N 刀，花在站位上还是花在方向上 ----
        mesh_neck = meshes["02-neck"]
        axis_neck = np.asarray([0.0, 1.0, 0.0])
        print("\n### 预算曲线（短颈 02-neck，真值 1.250）：同样 N 刀怎么花")
        print(f"  {'预算 N':>6} {'A 实刀':>7} {'A 读数':>9} {'A 误差':>8} "
              f"{'B 实刀':>7} {'B 站位×方向':>12} {'B 读数':>9} {'B 误差':>8}")
        budget_rows = []
        for n in (6, 12, 24, 48, 96, 192):
            a, _ = strategy_stations(mesh_neck, axis_neck, n)
            b, info = strategy_orientations(mesh_neck, axis_neck, n, per_station=8)
            ea = abs(a - 1.25) / 1.25 * 100 if a is not None else float("nan")
            eb = abs(b - 1.25) / 1.25 * 100 if b is not None else float("nan")
            budget_rows.append((n, a, ea, b, eb))
            print(f"  {n:>6} {n:>7} {a:9.3f} {ea:7.1f}% {info['cuts']:>7} "
                  f"{str(info['stations']) + 'x8':>12} {b:9.3f} {eb:7.1f}%")

        # ---- 图 0：预算曲线 ----
        fig0 = Svg(980, 470)
        box0 = (90, 60, 560, 300)
        axes(fig0, box0, "number of cuts (budget)", "error vs true bottleneck (%)", (0, 200), (0, 240))
        fig0.polyline([map_xy(box0, (0, 200), (0, 240), n, ea) for n, _, ea, _, _ in budget_rows],
                      "#2c7fb8", 2.0)
        fig0.polyline([map_xy(box0, (0, 200), (0, 240), n, eb) for n, _, _, _, eb in budget_rows],
                      "#c0392b", 2.0)
        fig0.text(box0[0] + box0[2] - 6, box0[1] + 22, "A: stations only", size=12, anchor="end", fill="#2c7fb8")
        fig0.text(box0[0] + box0[2] - 6, box0[1] + 42, "B: stations + 8 orientations", size=12, anchor="end",
                  fill="#c0392b")
        fig0.text(box0[0], box0[1] - 20,
                  "02-neck: the neck is 2mm of a 20mm passage - stations are what find it",
                  size=13, weight="bold")
        fig0.save(FIGURES / "00-budget-vs-strategy.svg")

        # ---- 图 1：采样密度（短颈） ----
        mesh = mesh_neck
        axis = axis_neck
        dense = sweep(mesh, axis, 200)
        sparse = sweep(mesh, axis, 10)
        fig = Svg(980, 470)
        box = (90, 60, 560, 300)
        axes(fig, box, "station along the passage axis (mm)", "MIC radius (mm)", (-10, 10), (0, 4.6))
        low, high = extent_along(mesh, axis)
        fx = lambda at: -10 + 20 * (at - low) / (high - low)
        pts = [map_xy(box, (-10, 10), (0, 4.6), fx(at), r) for at, r in dense if r is not None]
        fig.polyline(pts, "#2c7fb8", 2.4)
        for at, r in sparse:
            if r is not None:
                px, py = box[0] + box[2] * (fx(at) + 10) / 20, box[1] + box[3] * (1 - r / 4.6)
                fig.circle(px, py, 4.5, "#c0392b", "white", 1.6)
        ytrue = box[1] + box[3] * (1 - 1.25 / 4.6)
        fig.line(box[0], ytrue, box[0] + box[2], ytrue, "#c0392b", 1.4, dash="6 4")
        fig.text(box[0] + box[2] - 4, ytrue - 8, "true bottleneck r = 1.250", size=12,
                 anchor="end", fill="#c0392b")
        fig.text(box[0], box[1] - 20, "02-neck: 200 stations (blue line) vs 10 stations (red dots)",
                 size=13, weight="bold")
        fig.text(box[0], box[1] + box[3] + 58,
                 "10 stations: 2mm neck sits between stations -> min reads up to 3.97 (over-report)",
                 size=12, fill="#444444")
        # 右侧：颈截面 + MIC
        rhs = (700, 60, 230, 300)
        fig.rect(*rhs, fill="#fbfbfb")
        geom, (u, v, origin) = void_region(mesh, axis, 0.0)
        if geom is None:
            geom = shapely.Polygon()
        scale = rhs[2] / 9.0
        cx, cy = rhs[0] + rhs[2] / 2, rhs[1] + rhs[3] / 2
        for poly in (geom.geoms if geom.geom_type != "Polygon" else [geom]):
            outer = [(cx + x * scale, cy - y * scale) for x, y in poly.exterior.coords]
            fig.poly(outer, "#2c7fb8", "#dceaf7", 1.4)
        radius, extra = mic_of(geom)
        geom_mic, centre = extra
        fig.circle(cx + centre[0] * scale, cy - centre[1] * scale, radius * scale, "#c0392b", "none", 1.8)
        fig.text(cx, rhs[1] + 22, "section at the neck", size=12, anchor="middle")
        fig.text(cx, rhs[1] + rhs[3] - 10, f"MIC r = {radius:.3f}", size=12, anchor="middle", fill="#c0392b")
        fig.save(FIGURES / "01-neck-sampling.svg")

        # ---- 图 2：朝向与擦切（扁缝） ----
        mesh = meshes["04-thin-gap"]
        fig2 = Svg(980, 470)
        box2 = (90, 60, 560, 310)
        axes(fig2, box2, "angle between the cut normal and the gap axis (deg)", "MIC radius (mm)", (0, 90), (0, 5.4))
        gap_scan = []
        for tilt in np.arange(0, 90.1, 1.0):
            t = np.radians(float(tilt))
            normal = np.array([0.0, np.sin(t), np.cos(t)])
            radius, _ = cut(mesh, normal, 0.0)
            gap_scan.append((float(tilt), radius))
        accepted = [(x, y) for x, y in gap_scan if y is not None]
        rejected = [x for x, y in gap_scan if y is None]
        if rejected:
            xr = map_xy(box2, (0, 90), (0, 5.4), max(rejected) + 0.5, 0)[0]
            fig2.rect(box2[0], box2[1], max(1.0, xr - box2[0]), box2[3], "#fdecea", "#e8c4bd")
            fig2.text(box2[0] + 8, box2[1] + 18,
                      "no answer here: the cut does not separate the passage's ends", size=11, fill="#c0392b")
        if accepted:
            fig2.polyline([map_xy(box2, (0, 90), (0, 5.4), x, y) for x, y in accepted], "#2c7fb8", 1.8)
        ytrue2 = box2[1] + box2[3] * (1 - 0.25 / 5.4)
        fig2.line(box2[0], ytrue2, box2[0] + box2[2], ytrue2, "#555555", 1.2, dash="6 4")
        fig2.text(box2[0] + 4, ytrue2 - 8, "true bottleneck r = 0.250", size=12, fill="#555555")
        fig2.text(box2[0], box2[1] - 20,
                  "04-thin-gap: turning the cut only decides WHETHER you get an answer, not how good it is",
                  size=13, weight="bold")
        fig2.text(box2[0], box2[1] + box2[3] + 58,
                  "every accepted cut returns exactly 0.250 - the gap never changed", size=12, fill="#444444")
        fig2.save(FIGURES / "02-orientation-and-grazing.svg")

        # ---- 图 3：三种"盲/封"，三个都不是 0 ----
        def profile_z(mesh, lo, hi, count=140):
            return [(float(at), cut(mesh, [0, 0, 1], float(at))[0])
                    for at in np.linspace(lo, hi, count)]

        fig3 = Svg(980, 560)
        panels = (
            ("05-blind-pocket", (-4.5, 9.0), "05 flat bottom: the section ENDS",
             "past the bottom the plane is entirely inside material, so it holds NO void "
             "face at all. Reading that as 'r = 0' would fail every blind feature."),
            ("08-blind-cone", (-6.5, 7.0), "08 conical tip: it DOES taper to 0",
             "here the MIC really reaches 0 - but that 0 is the DEAD END of the feature, "
             "not the passage. min-over-stations would report 0 for a O8 opening."),
            ("06-sealed-cavity", (-10.0, 10.0), "06 sealed cavity: sections look WIDE",
             "up to 5.0. The MIC never says 0; that 0 comes from topology (no passage "
             "exists at all), which is S2-a's negative-volume test."),
        )
        for index, (name, window, title, note) in enumerate(panels):
            box3 = (70 + index * 305, 60, 270, 250)
            axes(fig3, box3, None, "MIC radius (mm)", window, (0, 6.2))
            prof = profile_z(meshes[name], window[0] + 0.5, window[1] - 0.5)
            pts = [map_xy(box3, window, (0, 6.2), at, r) for at, r in prof if r is not None]
            fig3.polyline(pts, "#2c7fb8", 2.0)
            fig3.text(box3[0], box3[1] - 20, title, size=12, weight="bold")
            words, line, lines = note.split(), "", []
            for word in words:
                if len(line) + len(word) > 42:
                    lines.append(line)
                    line = word
                else:
                    line = f"{line} {word}".strip()
            lines.append(line)
            for k, text in enumerate(lines[:4]):
                fig3.text(box3[0], box3[1] + box3[3] + 30 + 14 * k, text, size=10, fill="#444444")
        fig3.text(490, 545, "station along +z (mm)  ->", size=12, anchor="middle")
        fig3.save(FIGURES / "03-blind-and-sealed.svg")

        # ---- 图 4：只有 STL 的外来件（椭圆颈） ----
        fig4 = Svg(980, 470)
        box4 = (90, 60, 520, 300)
        axes(fig4, box4, "station along +z (mm)", "MIC radius (mm)", (-10, 10), (0, 8.2))
        mesh7 = meshes["07-imported-oval-neck"]
        prof7 = profile_z(mesh7, -9.5, 9.5, 200)
        pts7 = [map_xy(box4, (-10, 10), (0, 8.2), at, r) for at, r in prof7 if r is not None]
        fig4.polyline(pts7, "#2c7fb8", 2.0)
        ylow = map_xy(box4, (-10, 10), (0, 8.2), 0, 1.0)[1]
        fig4.line(box4[0], ylow, box4[0] + box4[2], ylow, "#c0392b", 1.2, dash="6 4")
        fig4.text(box4[0] + 6, ylow - 8, "true bottleneck r = 1.000 (the oval neck)", size=11, fill="#c0392b")
        fig4.text(box4[0], box4[1] - 20,
                  "07 imported, STL only, no source - and the neck is NOT round",
                  size=13, weight="bold")
        fig4.text(box4[0], box4[1] + box4[3] + 58,
                  "a circle fit calls this neck non-circular and refuses; the MIC returns 1.000 exactly",
                  size=12, fill="#444444")
        rhs4 = (680, 60, 260, 300)
        fig4.rect(*rhs4, fill="#fbfbfb")
        geom7, (u7, v7, origin7) = void_region(mesh7, [0, 0, 1], 7.0)   # z=7：在腔体(±5)之上，只有颈
        scale7 = rhs4[2] / 5.0
        cx7, cy7 = rhs4[0] + rhs4[2] / 2, rhs4[1] + rhs4[3] / 2
        if geom7 is not None:
            for poly in (geom7.geoms if geom7.geom_type != "Polygon" else [geom7]):
                fig4.poly([(cx7 + x * scale7, cy7 - y * scale7) for x, y in poly.exterior.coords],
                          "#2c7fb8", "#dceaf7", 1.4)
            radius7, extra7 = mic_of(geom7)
            centre7 = np.asarray(extra7[1], dtype=float)
            fig4.circle(cx7 + centre7[0] * scale7, cy7 - centre7[1] * scale7,
                        radius7 * scale7, "#c0392b", "none", 1.8)
            fig4.text(cx7, rhs4[1] + 22, "section at z = 7 (above the cavity)", size=11, anchor="middle")
            fig4.text(cx7, rhs4[1] + rhs4[3] - 12, f"ellipse 2.4 x 2.0 -> MIC r = {radius7:.3f}",
                      size=12, anchor="middle", fill="#c0392b")
        fig4.save(FIGURES / "04-stl-only-imported.svg")

        print("\n### 朝向扫描（扁缝 04，真值 0.250）：从'顺着缝切'转到'横切缝'")
        print(f"  {'刀口法向与缝轴的夹角':>20} {'MIC 半径':>10}   说明")
        mesh = meshes["04-thin-gap"]
        for tilt in (0, 15, 30, 45, 60, 75, 85, 89, 90):
            t = np.radians(tilt)
            radius, _ = cut(mesh, np.array([0.0, np.sin(t), np.cos(t)]), 0.0)
            note = "拒绝：这一刀不把通道两端分开" if radius is None else ""
            shown = "(拒绝)" if radius is None else f"{radius:8.3f}"
            print(f"  {tilt:>17}° {shown:>10}   {note}")

        print("\n### 图（PNG）")
        for name in ("00-budget-vs-strategy", "01-neck-sampling", "02-orientation-and-grazing",
                     "03-blind-and-sealed", "04-stl-only-imported"):
            print(f"  figures/{name}.png")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
