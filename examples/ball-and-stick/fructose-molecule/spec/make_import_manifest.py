#!/usr/bin/env python3
"""Emit the import list (part name, STL path, datums) for the CAD registrar."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
m = json.loads((HERE / "molecule.json").read_text())
atoms = {a["id"]: a for a in m["atoms"]}
bonds = {b["id"]: b for b in m["bonds"]}

parts = []
for aid, a in atoms.items():
    if a["element"] == "H":
        continue
    parts.append(dict(part="Fru-" + aid, stl=f".tmp/all2/Fru-{aid}.stl",
                      intent=f"果糖 {aid} 原子球（{a['element']}，{len(a['bosses'])} 个接口）",
                      datums=a["datums"]))
parts.append(dict(part="Fru-H", stl=".tmp/all2/Fru-H.stl",
                  intent="果糖 H 原子球（12 个实例共用，单个轻接口）",
                  datums=atoms["H01"]["datums"]))
for bid, b in bonds.items():
    parts.append(dict(part=b["part"], stl=f".tmp/all2/{b['part']}.stl",
                      intent=f"果糖 {bid} 键棍（{b['a']}-{b['b']}，{b['kind']}，L={b['L_mm']:.3f} mm）",
                      datums=b["datums"]))
for src, part in (("B03", "GUIDE-B03"), ("B15", "GUIDE-B15")):
    b = bonds[src]
    parts.append(dict(part=part, stl=f".tmp/all2/{part}.stl",
                      intent=f"{part}：仅用于插入路径仿真的去卡扣导向棍（不可交付）",
                      datums=b["datums"]))
out = dict(scale="mm", parts=parts)
(HERE / "import_manifest.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
print(f"{len(parts)} parts -> spec/import_manifest.json")
