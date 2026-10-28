#!/usr/bin/env python3
"""Fill version ids into assembly_plan.json and write assembly/assembly.json.

version_map.json: {"Fru-C1":"v001", ..., "Fru-H":"v013", ...}
runs.json (optional): {"motion_B03":"r012","motion_B15":"r013"}
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
plan = json.loads((ROOT / "assembly" / "assembly_plan.json").read_text())
vmap = json.loads((HERE / "version_map.json").read_text())
runs_path = HERE / "runs.json"
runs = json.loads(runs_path.read_text()) if runs_path.exists() else {}

def fill(node):
    if node.get("kind") == "part":
        part = node.get("part")
        if part not in vmap:
            raise SystemExit(f"version_map missing part {part!r}")
        node["version"] = vmap[part]
        node["source"] = "imported"
        node["material"] = "PLA+"
    for child in node.get("children", []):
        fill(child)

root = plan["root"]
fill(root)

# Motion-clearance interfaces for the two representative guide runs.
# The guide rods are separate, bead-relieved parts; the note is part of the
# contract so a human reviewer can see what the motion half did and did not
# cover.  The static half still measures the delivered atom/rod datums.
def motion_iface(rod_id, atom_a, atom_b, run_key, title):
    if run_key not in runs:
        return None
    def endpoint(atom, other):
        return f"{atom}.ax_heavy" if atom.startswith("H") else f"{atom}.ax_{other}"
    return dict(
        id=f"I_{rod_id}_motion",
        a=endpoint(atom_a, atom_b),
        b=f"{rod_id}.A_axis",
        type="滑动副",
        check="motion-clearance",
        severity="hard",
        nominal=dict(quantity="距离", value=0.0),
        tolerance=dict(min=0.0, max=0.25),
        params=dict(runId=runs[run_key]),
        note=title + "；运动半使用去卡扣的 GUIDE 件，只证明刚性导入/落座路径；卡扣保持力由静态几何与拉脱试验协议负责。",
    )

for key, rod_id, atom_a, atom_b, title in (
    ("motion_B03", "B03", "C3", "C4", "C3-C4 重接口插入导向仿真"),
    ("motion_B15", "B15", "C3", "H04", "C3-H04 轻接口插入导向仿真"),
):
    iface = motion_iface(rod_id, atom_a, atom_b, key, title)
    if iface:
        root["interfaces"].append(iface)

(ROOT / "assembly" / "assembly.json").write_text(json.dumps(plan, indent=2, ensure_ascii=False))
print(f"wrote assembly/assembly.json: {len(root['children'])} parts, {len(root['interfaces'])} interfaces")
print("versions:", ", ".join(f"{k}={v}" for k, v in sorted(vmap.items())))
