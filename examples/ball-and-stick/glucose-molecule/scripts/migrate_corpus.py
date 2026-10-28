#!/usr/bin/env python3
"""把本示例的语料从"仓库根项目"（`<repo>/cad-data`，指向 examples/toy-balance2/cad-data 的符号链接）
整体迁到 `examples/ball-and-stick/glucose-molecule/cad-data/`。

为什么要迁：CAD 语料的根是**会话 cwd 下的 cad-data/**。子智能体的会话 cwd 是仓库根，
而仓库根的 cad-data 是符号链接 —— 于是它的 7 个零件的版本与全部运行记录被写进了另一个示例的语料里。

迁移口径：**7 个葡萄糖零件的全部版本**（含被取代的第一版棍 v034–v037）+ 引用这些版本的运行记录。
版本号/运行号保持不变（不改写运行记录里的引用），所以 BUILD.md 里引用的 id 迁移后依然有效。

用法： python3 scripts/migrate_corpus.py [--dry-run]
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent          # examples/ball-and-stick/glucose-molecule
SRC = (HERE.parent.parent / "toy-balance2" / "cad-data").resolve()
DST = (HERE / "cad-data")
DRY = "--dry-run" in sys.argv

PART_NAMES = {"碳原子 C", "氧原子 O", "氢原子 H",
              "键棒 7.2 (C-O 环)", "键棒 6.6 (C-C)", "键棒 5.2 (C-H/C-O)", "键棒 4.8 (O-H)"}

assert SRC.is_dir(), f"源语料不存在: {SRC}"
assert not DST.exists() or not any(DST.iterdir()), f"目标语料非空，拒绝搬迁: {DST}"

vman = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
pman = json.loads((SRC / "parts" / "manifest.json").read_text(encoding="utf-8"))
rman = json.loads((SRC / "runs" / "manifest.json").read_text(encoding="utf-8"))

mp = [p for p in pman["parts"] if p["name"] in PART_NAMES]
assert len(mp) == 7, f"零件条目数 {len(mp)} != 7: {[p['name'] for p in mp]}"
want_parts = {p["id"] for p in mp}
want_versions = {vid for p in mp for vid in p["versionIds"]}

mv = [v for v in vman["versions"] if v["id"] in want_versions]
assert {v["id"] for v in mv} == want_versions, f"版本缺失: {want_versions - {v['id'] for v in mv}}"
assert all(v["partId"] in want_parts for v in mv), "有版本不属于这 7 个零件"

mr = [r for r in rman["runs"]
      if r.get("sourceVersionIds") and set(r["sourceVersionIds"]) <= want_versions]

print(f"源:   {SRC}")
print(f"目标: {DST}")
print(f"版本 {len(mv)}: {sorted(want_versions)}")
print(f"零件 {len(mp)}: {sorted(want_parts)}")
print(f"运行 {len(mr)}: {[r['id'] for r in mr]}")
if DRY:
    sys.exit(0)

for sub in ("versions", "parts", "runs"):
    (DST / sub).mkdir(parents=True, exist_ok=True)

for v in mv:
    shutil.copytree(SRC / "versions" / v["id"], DST / "versions" / v["id"])
for r in mr:
    shutil.copytree(SRC / "runs" / r["id"], DST / "runs" / r["id"])

(DST / "manifest.json").write_text(json.dumps({"versions": mv}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(DST / "parts" / "manifest.json").write_text(
    json.dumps({"schemaVersion": 1, "parts": mp}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(DST / "runs" / "manifest.json").write_text(
    json.dumps({"schemaVersion": 1, "runs": mr}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(DST / "project.json").write_text(json.dumps({
    "schemaVersion": 1, "cwd": str(HERE.resolve()), "key": HERE.name,
    "title": HERE.name, "createdAt": "2026-10-27T00:00:00.000Z",
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

# 原语料恢复原状（只删搬走的条目）
for v in mv:
    shutil.rmtree(SRC / "versions" / v["id"])
for r in mr:
    shutil.rmtree(SRC / "runs" / r["id"])
(SRC / "manifest.json").write_text(json.dumps(
    {"versions": [v for v in vman["versions"] if v["id"] not in want_versions]},
    ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(SRC / "parts" / "manifest.json").write_text(json.dumps(
    {"schemaVersion": 1, "parts": [p for p in pman["parts"] if p["id"] not in want_parts]},
    ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(SRC / "runs" / "manifest.json").write_text(json.dumps(
    {"schemaVersion": 1, "runs": [r for r in rman["runs"] if r["id"] not in {x["id"] for x in mr}]},
    ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

print("迁移完成；原语料已移除对应条目")
