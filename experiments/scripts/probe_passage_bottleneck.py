#!/usr/bin/env python
"""验收 `op_passage_bottleneck`：9 个已知件 + 两个复合件。

台架（`examples/passage-bottleneck/`）提供解析真值；本探针把每个件的**一个开口**（点 + 轴）
交给 op，检查：

  * 贯通件命中真值（3.000 / 1.250 / 4.000 / 0.250 / 1.000 / 3.750）；
  * 盲件（05 平底、08 锥底）**必须拒绝出数**（未被判定，不许把死胡同当瓶颈）；
  * 封死腔（06）**必须报"没有通路"**（0 由拓扑给，不由内切圆给）；
  * 复合件 A（排液孔 Ø3 + 装饰性盲孔 Ø1）锚到排液孔必须给 1.5，不被盲孔带偏；
  * 复合件 B（Ø6 与 Ø1 两条**平行**贯通孔）分别锚定必须给 ~2.996 与 ~0.499
    —— 盲扫会给 2.996（把 Ø1 盖住），这一条就是"必须锚定"的证据。

运行：
    .tmp-measure-runtime/venv/bin/python experiments/scripts/probe_passage_bottleneck.py
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

import numpy as np
import trimesh

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "dsh-cad-harness" / "python"))
from cad_worker import worker  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "bottleneck_report", REPO / "examples" / "passage-bottleneck" / "tools" / "bottleneck_report.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)

# (夹具, 开口上的一点, 通路轴, 开口的特征尺度 mm, 真值或 None)
# 特征尺度（约 sqrt(开口面积)）就是宿主会从 list_features 的 areaMm2 传进来的那个数：
# 它决定走查步长，不传就只能退回 span/50 的保守默认值（预算常常走不完全程）。
CASES = [
    ("01-through-slot", (0, -10, 0), (0, 1, 0), 6.00, 3.000),
    ("02-neck", (0, -10, 0), (0, 1, 0), 7.09, 1.250),
    ("03-tilted-bore", (0, 0, 0), (-0.5, 0.8660254, 0), 7.09, 4.000),
    ("04-thin-gap", (0, -10, 0), (0, 1, 0), 2.24, 0.250),
    ("05-blind-pocket", (0, 0, 5), (0, 0, 1), 7.09, None),
    ("07-imported-oval-neck", (0, 0, 9), (0, 0, 1), 2.19, 1.000),
    ("08-blind-cone", (0, 0, 5), (0, 0, 1), 7.09, None),
    ("09-l-slot", (0, 0, 3), (0, 0, 1), 16.97, 3.750),
]

failures = 0


def report(ok, label, detail=""):
    global failures
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{('  — ' + detail) if detail else ''}")
    if not ok:
        failures += 1


def run(mesh, anchor, axis, size, budget=120):
    handle = tempfile.NamedTemporaryFile(suffix=".stl", delete=False)
    handle.close()
    mesh.export(handle.name)
    return worker.op_passage_bottleneck(
        {"path": handle.name, "fromMm": list(anchor), "fromAxis": list(axis),
         "fromSizeMm": size, "budget": budget})


def main() -> int:
    tmp = Path(tempfile.mkdtemp())
    print("### 9 个已知件（锚点 = 一个开口，轴 = 该通路的轴）")
    print(f"  {'夹具':<24} {'真值':>7} {'读数':>7} {'刀':>4} {'接受':>4}  口径")
    for name, anchor, axis, size, truth in CASES:
        mesh, _source = bench.fixture_mesh(name, tmp)
        out = run(mesh, anchor, axis, size)
        got = out.get("bottleneckRadiusMm")
        if truth is None:
            ok = (got is None) and out.get("reachable") is False
            shown = "拒绝" if got is None else f"{got:.3f}"
            verdict = "盲特征：不出数" if ok else "!! 盲特征却出了数"
        else:
            ok = got is not None and abs(got - truth) <= 0.01
            shown = "—" if got is None else f"{got:.3f}"
            verdict = ("贯通，命中真值" if ok else f"!! 应为 {truth:.3f}")
        print(f"  {name:<24} {('--' if truth is None else f'{truth:.3f}'):>7} {shown:>7} "
              f"{out.get('cuts', 0):>4} {out.get('sectionsAccepted', 0):>4}  {verdict}")
        report(ok, f"{name}: {verdict}", out.get("refused", "")[:70])

    # 06 封死腔：没有开口可锚，必须报"没有通路"
    mesh6, _ = bench.fixture_mesh("06-sealed-cavity", tmp)
    out6 = run(mesh6, (0, 0, 0), (0, 0, 1), 8.0)
    report(out6.get("bottleneckRadiusMm") is None and out6.get("topology", {}).get("tunnels") == 0,
           "06-sealed-cavity: 亏格 0 ⇒ 报'没有通路'，不给宽度",
           f"tunnels={out6.get('topology', {}).get('tunnels')} refused={(out6.get('refused') or '')[:48]}")

    print("\n### 复合件 A：排液孔 Ø3（合格）+ 装饰性盲孔 Ø1（不该被算进通路）")
    plate = trimesh.creation.box(extents=[40, 40, 10])
    mixed = plate.difference(trimesh.creation.cylinder(radius=1.5, height=20, sections=64))
    mixed = mixed.difference(trimesh.creation.cylinder(radius=0.5, height=6, sections=64)
                             .apply_translation([12, 12, 2]))
    out_a = run(mixed, (0, 0, 5), (0, 0, 1), 3.0)
    got_a = out_a.get("bottleneckRadiusMm")
    report(got_a is not None and abs(got_a - 1.5) <= 0.01,
           "锚到排液孔 ⇒ 1.500（盲孔不参与）", f"读数 {got_a}")

    print("\n### 复合件 B：两条平行贯通孔 Ø6 与 Ø1（盲扫会把 Ø1 盖住）")
    parallel = plate.difference(trimesh.creation.cylinder(radius=3.0, height=20, sections=64)
                                .apply_translation([-12, 0, 0]))
    parallel = parallel.difference(trimesh.creation.cylinder(radius=0.5, height=20, sections=64)
                                   .apply_translation([12, 0, 0]))
    out_b1 = run(parallel, (12, 0, 5), (0, 0, 1), 1.0)
    out_b2 = run(parallel, (-12, 0, 5), (0, 0, 1), 6.0)
    got_b1, got_b2 = out_b1.get("bottleneckRadiusMm"), out_b2.get("bottleneckRadiusMm")
    report(got_b1 is not None and abs(got_b1 - 0.5) <= 0.01,
           "锚到 Ø1 那条 ⇒ 0.500", f"读数 {got_b1}")
    report(got_b2 is not None and abs(got_b2 - 3.0) <= 0.02,
           "锚到 Ø6 那条 ⇒ 3.000", f"读数 {got_b2}")
    print("\n### 复合件 A′：把锚点放在那个**盲孔**上（零件确有通路，但这条不是）")
    out_a2 = run(mixed, (12, 12, 5), (0, 0, 1), 1.0)
    report(out_a2.get("bottleneckRadiusMm") is None and out_a2.get("reachable") is False,
           "锚到盲孔 ⇒ 拒绝出数（死胡同不许当瓶颈）",
           f"reachable={out_a2.get('reachable')} ends={out_a2.get('endConditions')} "
           f"accepted={out_a2.get('sectionsAccepted')}")

    blind_sweep = bench.sweep(parallel, (0, 0, 1), 200)
    swept = min(r for _a, r in blind_sweep if r is not None)
    report(swept > 2.9,
           "对照：同零件**盲扫**把 Ø1 完全盖住（这就是必须锚定的理由）", f"盲扫读数 {swept:.3f}")

    print(f"\n{'OK' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
