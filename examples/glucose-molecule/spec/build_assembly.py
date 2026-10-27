#!/usr/bin/env python3
"""生成 assembly/assembly.json：48 个零件实例 + 每个 peg/socket 接口的三项判据。

输入：
  spec/instances.json      由 gen_scad.py 产出的位姿表（不含版本号）
  spec/versions.json       {"parts": {"atom_C": "v001", ...}, "run": "r012"(可选)}

接口（每对 peg/球 三条）：
  coaxial        轴偏移 ≤0.15mm   —— 棍确实插在孔里、没有歪
  seat-distance  台肩面到定心平台的距离 0.05mm（装配名义间隙）≤0.15
  diameter-match 孔 Ø5.20 vs 轴 Ø5.00 → 直径间隙 0.20（判据带 0.05..0.35）

棍与球成对，只有这 48 对是"靠近"的；未声明近邻应为 0。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
S = json.loads((HERE / "instances.json").read_text(encoding="utf-8"))
V = json.loads((HERE / "versions.json").read_text(encoding="utf-8"))
PARTS: dict[str, str] = V["parts"]
RUN = V.get("run")

MOTION_RUN_NOTE = "r084"   # 带卡珠的实件行程 run（记录弹性挤压量，不作为通过证据）
SEAT_GAP = 0.0         # 台肩面直接落在定心平台上（装配名义间隙 0，公差带 0..0.15）
RADIAL_TOL = 0.15
DIA_TOL = (0.05, 0.35)

PART_LABEL = {
    "atom_C": "碳原子 C",
    "atom_O": "氧原子 O",
    "atom_H": "氢原子 H",
    "stick_7.2": "键棒 7.2 (C-O 环)",
    "stick_6.6": "键棒 6.6 (C-C)",
    "stick_5.2": "键棒 5.2 (C-H/C-O)",
    "stick_4.8": "键棒 4.8 (O-H)",
}


def node(nid: str, name: str, part_key: str, translate, rotate) -> dict:
    return {
        "id": nid, "kind": "part", "name": name, "part": PART_LABEL[part_key],
        "version": PARTS[part_key], "source": "generated", "material": "PLA",
        "transform": {"translate": [round(float(x), 4) for x in translate],
                      "rotate": [round(float(x), 4) for x in rotate]},
    }


def main() -> None:
    missing = [k for k in PART_LABEL if k not in PARTS]
    if missing:
        sys.exit(f"versions.json 缺零件版本号: {missing}")

    children = [node(a["atom"], a["name"], a["part_key"], a["translate"], a["rotate"])
                for a in S["instances"]]
    children += [node(b["bond"], b["name"], b["part_key"], b["translate"], b["rotate"])
                 for b in S["bond_instances"]]

    interfaces: list[dict] = []
    for b in S["bond_instances"]:
        ai, aj, bid = b["pegA_atom"], b["pegB_atom"], b["bond"]
        for side, atom, sock, peg, seat in (
            ("a", ai, b["pegA_sock"], "pegA", "seatA"),
            ("b", aj, b["pegB_sock"], "pegB", "seatB"),
        ):
            interfaces.append({
                "id": f"同轴-{bid}-{side}", "a": f"{atom}.{sock}", "b": f"{bid}.{peg}",
                "type": "贴合", "severity": "hard", "check": "coaxial",
                "nominal": {"quantity": "同轴度", "value": 0.0},
                "tolerance": {"min": 0.0, "max": RADIAL_TOL},
                "note": f"{atom} 的 {sock} 轴线与 {bid} 的 {peg} 轴线应重合",
            })
            interfaces.append({
                "id": f"就位-{bid}-{side}", "a": f"{atom}.{sock}", "b": f"{bid}.{seat}",
                "type": "贴合", "severity": "hard", "check": "distance",
                "nominal": {"quantity": "距离", "value": SEAT_GAP},
                "tolerance": {"min": 0.0, "max": RADIAL_TOL},
                "note": "台肩面到定心平台的轴向距离（装配名义间隙 0.05mm）",
            })
            interfaces.append({
                "id": f"配合-{bid}-{side}", "a": f"{atom}.{sock}", "b": f"{bid}.{peg}",
                "type": "紧固", "severity": "hard", "check": "diameter-match",
                "nominal": {"quantity": "直径", "value": 0.20},
                "tolerance": {"min": DIA_TOL[0], "max": DIA_TOL[1]},
                "note": "直径间隙 = 孔 Ø5.20 − 轴 Ø5.00",
            })

    # 行程：这一对代表接口声明为滑动副。**不**默认引用 motion run —— 刚性引擎里
    # 弹性卡珠过喉口必然产生 0.1mm 挤压（实测 6 次事件 × 0.769mm³，run r084），
    # 引擎只会把它判成 fail；拿它当"通过"是把引擎边界说成设计结论。
    # 所以：静态就位距离照常判；行程的物理量写在 note 里，runId 只在明确要求时引用。
    b = next(x for x in S["bond_instances"] if x["kind_of_bond"] == "CC")
    iface = {
        "id": f"行程-{b['bond']}-a", "a": f"{b['pegA_atom']}.{b['pegA_sock']}",
        "b": f"{b['bond']}.pegA", "type": "滑动副", "severity": "hard",
        "check": "motion-clearance",
        "nominal": {"quantity": "距离", "value": 0.0},
        "tolerance": {"min": 0.0, "max": RADIAL_TOL},
        "note": ("行程证据是弹性的：卡珠 Ø5.40 过 Ø5.20 喉口单边挤压 0.10mm，"
                 "刚性运动仿真因此报告 6 次挤压事件（每次 0.769mm³，run "
                 f"{MOTION_RUN_NOTE}），不能判 pass；就位状态由 0 干涉证明"
                 "（validate_assembly + 整机 1128 对布尔复核）"),
    }
    if RUN:
        iface["params"] = {"runId": RUN}
    else:
        iface["note"] += "。本清单不引用该 run 作为通过证据"
    interfaces.append(iface)

    manifest = {
        "schemaVersion": 1,
        "name": "β-D-吡喃葡萄糖 球棍模型（可拆装）",
        "unit": "mm", "up": "z",
        "root": {
            "id": "root", "kind": "assembly", "name": "整机（24 球 + 24 棍）",
            "children": children,
            "interfaces": interfaces,
        },
    }
    out = HERE.parent / "assembly" / "assembly.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out}: {len(children)} 节点, {len(interfaces)} 接口"
          + (f", 行程证据 {RUN}" if RUN else ", 尚无行程证据"))

    # 12 节点子清单：六元环（6 球 + 6 棍）。为什么单独一份：
    # check_assembly 的近邻扫描是 O(n²) 实心布尔，48 件 × 1128 对实测要 ~800s，
    # 而 python worker 的硬上限是 120s —— 整机清单**跑不完**（BUILD.md 记录）。
    # 环是公差最吃紧的一段，12 节点 66 对能在预算内跑完，所以它作为可判定的那半份。
    ring_atoms = ["O5", "C1", "C2", "C3", "C4", "C5"]
    ring_bonds = [b for b in S["bond_instances"]
                  if b["pegA_atom"] in ring_atoms and b["pegB_atom"] in ring_atoms]
    assert len(ring_bonds) == 6, len(ring_bonds)
    ring_children = [c for c in children if c["id"] in set(ring_atoms) | {b["bond"] for b in ring_bonds}]
    ring_ifaces = [i for i in interfaces
                   if i["a"].split(".")[0] in set(ring_atoms) | {b["bond"] for b in ring_bonds}
                   and i["b"].split(".")[0] in set(ring_atoms) | {b["bond"] for b in ring_bonds}]
    ring_manifest = {
        "schemaVersion": 1,
        "name": "β-D-葡萄糖 六元环子装配（12 节点，可在 worker 120s 预算内判定）",
        "unit": "mm", "up": "z",
        "root": {
            "id": "ring", "kind": "assembly", "name": "六元环（O5+C1–C5，6 根键棒）",
            "children": ring_children,
            "interfaces": ring_ifaces,
        },
    }
    ring_out = HERE.parent / "assembly" / "assembly_ring.json"
    ring_out.write_text(json.dumps(ring_manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {ring_out}: {len(ring_children)} 节点, {len(ring_ifaces)} 接口")


if __name__ == "__main__":
    main()
