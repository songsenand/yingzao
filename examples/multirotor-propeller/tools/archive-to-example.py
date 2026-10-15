#!/usr/bin/env python3
"""把本次会话在父工作区语料里跑出来的零件/运行，归集成 examples/ 里一套自洽的 cad-data。

为什么要这一步：dsh-cad-harness 的语料根是**会话工作目录下的 cad-data/**（project.ts），
本次会话的 cwd 是仓库根，所以零件先落在根 `cad-data/`；而示例要能"换个目录打开就是
一个完整项目"，于是把与螺旋桨有关的那几条记录搬进来，并把 id 重排成从 v001 起的
连续序列（否则一个示例项目里只有 v038/v044/v045/v046，前面 37 个版本查无此人）。

重排是**纯改名**：版本目录内容、datum、网格、运行报告一个字节都没动，只改 id 与引用。
脚本事后自检：搬完之后不允许再出现指向未搬迁 id 的引用。

用法： <runtime venv>/python tools/archive-to-example.py [--src <父语料根>] [--dst <示例根>]
"""
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

# 本次会话的记录 → 示例内的编号
VER_MAP = {"v044": "v001", "v045": "v002", "v038": "v003", "v046": "v004"}
PART_MAP = {"p015": "p001", "p016": "p002", "p017": "p003", "p018": "p004"}
RUN_MAP = {"r006": "r001", "r007": "r002", "r008": "r003", "r009": "r004", "r011": "r005"}


def renumber(obj, *maps):
    """深度重写 JSON 里的 id：整串相等当然要换，嵌在标题里的 "… v044+v038 …" 也要换
    （按 vNNN/pNNN/rNNN 的词边界做替换）。"""
    m = {}
    for mp in maps:
        m.update(mp)
    if isinstance(obj, dict):
        return {k: renumber(v, *maps) for k, v in obj.items()}
    if isinstance(obj, list):
        return [renumber(v, *maps) for v in obj]
    if isinstance(obj, str):
        return re.sub(r"\b([vpr]\d{3})\b", lambda mo: m.get(mo.group(1), mo.group(1)), obj)
    return obj


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="cad-data")
    ap.add_argument("--dst", default="examples/multirotor-propeller")
    a = ap.parse_args()
    src, dst = Path(a.src).resolve(), Path(a.dst).resolve()
    out = dst / "cad-data"
    for sub in ("versions", "parts", "runs", "assembly"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    # ---- 版本 --------------------------------------------------------------
    vman = json.loads((src / "manifest.json").read_text())
    keep = [v for v in vman["versions"] if v["id"] in VER_MAP]
    assert len(keep) == len(VER_MAP), "父语料里少了版本：%s" % [i for i in VER_MAP if i not in {v['id'] for v in keep}]
    for v in keep:
        new = VER_MAP[v["id"]]
        shutil.copytree(src / "versions" / v["id"], out / "versions" / new, dirs_exist_ok=True)
    newvers = []
    for v in keep:
        w = renumber(dict(v), VER_MAP, PART_MAP)
        # 被搬迁的都是该零件在示例里的第 1 版，父版本不在本语料内 → 置空
        w["parentVersion"] = None
        newvers.append(w)
    newvers.sort(key=lambda x: x["id"])
    (out / "manifest.json").write_text(json.dumps({"versions": newvers}, ensure_ascii=False, indent=2) + "\n")

    # ---- 零件 --------------------------------------------------------------
    pman = json.loads((src / "parts" / "manifest.json").read_text())
    newparts = []
    for p in pman["parts"]:
        if p["id"] not in PART_MAP:
            continue
        q = dict(p)
        q["id"] = PART_MAP[p["id"]]
        q["versionIds"] = [VER_MAP[x] for x in p["versionIds"] if x in VER_MAP]
        newparts.append(q)
    newparts.sort(key=lambda x: x["id"])
    (out / "parts" / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "parts": newparts}, ensure_ascii=False, indent=2) + "\n")

    # ---- 运行记录 ----------------------------------------------------------
    rman = json.loads((src / "runs" / "manifest.json").read_text())
    keepruns = [r for r in rman["runs"] if r["id"] in RUN_MAP]
    for r in keepruns:
        shutil.copytree(src / "runs" / r["id"], out / "runs" / RUN_MAP[r["id"]], dirs_exist_ok=True)
    newruns = []
    for r in keepruns:
        w = renumber(r, VER_MAP, PART_MAP, RUN_MAP)
        w["id"] = RUN_MAP[r["id"]]
        w["sourceVersionIds"] = [VER_MAP[x] for x in r.get("sourceVersionIds", []) if x in VER_MAP]
        newruns.append(w)
    newruns.sort(key=lambda x: x["id"])
    (out / "runs" / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "runs": newruns}, ensure_ascii=False, indent=2) + "\n")

    # 运行报告里的版本/运行引用一并改名（同样是词边界替换，标题里的也换）
    for r in keepruns:
        d = out / "runs" / RUN_MAP[r["id"]]
        for f in d.glob("*.json"):
            try:
                (d / f.name).write_text(json.dumps(
                    renumber(json.loads(f.read_text()), VER_MAP, PART_MAP, RUN_MAP), ensure_ascii=False, indent=2) + "\n")
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass  # frames/parts 下的二进制或非 JSON

    # ---- project.json ------------------------------------------------------
    key = "%s-%s" % (dst.name, hashlib.sha1(str(dst).encode()).hexdigest()[:8])
    (out / "project.json").write_text(json.dumps({
        "schemaVersion": 1, "cwd": str(dst), "key": key, "title": dst.name,
    }, ensure_ascii=False, indent=2) + "\n")

    # ---- 装配清单 + check_assembly 报告：version / runId 一起改名 ---------------
    for man_path in sorted((dst / "assembly").glob("*.json")):
        man_path.write_text(json.dumps(
            renumber(json.loads(man_path.read_text()), VER_MAP, PART_MAP, RUN_MAP),
            ensure_ascii=False, indent=2) + "\n")
        print("assembly json renumbered ->", man_path.relative_to(dst))

    # ---- 自检：不允许残留指向未搬迁 id 的引用 -------------------------------
    alive = set(VER_MAP.values()) | set(PART_MAP.values()) | set(RUN_MAP.values())
    dead = set(VER_MAP) | set(PART_MAP) | set(RUN_MAP)
    pat = re.compile(r"\b([vpr]\d{3})\b")
    bad, checked = [], 0
    for f in sorted(list(out.rglob("*.json")) + list((dst / "assembly").glob("*.json"))):
        checked += 1
        for tok in set(pat.findall(f.read_text(errors="ignore"))):
            if tok in dead:
                bad.append("%s: %s" % (f.relative_to(dst), tok))
    print("copied versions :", ", ".join("%s→%s" % kv for kv in VER_MAP.items()))
    print("copied runs     :", ", ".join("%s→%s" % kv for kv in RUN_MAP.items()))
    print("json files scanned:", checked)
    print("dangling refs   :", bad if bad else "none ✓")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
