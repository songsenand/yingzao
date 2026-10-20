#!/usr/bin/env python3
"""审计「去重 / reasoning 回填 / schema 裁剪 / 图片」四项的可量化基线。

只读本机真实运行数据：
  $HOME/bench-runs/<题>/TASK*.events.jsonl          合并事件流：逐 step usage（绝对口径）
  $HOME/.dsh/sessions/.../session.v4.jsonl.zstd     逐条消息（构成口径）
  run-record.json 里的 sessionId                     题 ↔ 会话的映射

方法：
  1. 绝对量（Σctx、步数、峰值）取 step_end.usage 的 inputTokens+cacheReadTokens；
  2. 构成用「精确加权」：内容在第 k 步进入上下文，就会被第 k+1..N 步各重读一次，
     贡献 = 单价 × (N−k)。逐条按此累加，而不是拿「新增内容占比」当「重读占比」；
  3. 图片单价两条独立估计互证：
     a) 全局两参数最小二乘：ctx ≈ α·(非图片重读量) + c·(图片重读次数)；
     b) Δ 法：相邻两步 ctx 增量的中位数（含图步 / 不含图步对比）；
  4. 去重按 (工具, 规范化参数) 精确分组，并统计「参数相同但返回不同」的次数——
     那正是缓存必然给出过期答案的样本。

用法：
  python3 experiments/scripts/audit_token_levers.py
  python3 experiments/scripts/audit_token_levers.py --json > /tmp/audit.json
"""
from __future__ import annotations

import glob
import json
import math
import os
import subprocess
import sys
import collections

import numpy as np

HOME = os.path.expanduser("~")
SESSIONS = os.path.join(HOME, ".dsh", "sessions")
BENCH = os.path.join(HOME, "bench-runs")

CPT = 4
OVERHEAD = 4
IMG_TOK_HEURISTIC = 4800 // CPT      # pi-ai: ESTIMATED_IMAGE_CHARS/4 = 1200

RUNS = [
    ("01-mortise-bench", "recovered-01-mortise-bench", "TASK.events.jsonl",
     "session-7889e680-753c-429a-a1a4-3de3f80ae834"),
    ("01b-diagnosis", "recovered-01b-diagnosis", "TASK.events.jsonl",
     "session-77cbbc3c-3d92-4687-aac1-56312d71a547"),
    ("02-steam-engine", "02-steam-engine-glm53-high", "TASK*.events.jsonl",
     "session-4769cc38-a926-4c7d-b67a-db8ea69f9c86"),
    ("03-microscope", "03-microscope-glm53-high", "TASK*.events.jsonl",
     "session-f502ea6d-7902-4b58-98a5-c324bb81ead2"),
    ("04-rack-connector", "04-rack-connector-glm53-high", "TASK*.events.jsonl",
     "session-9539bf4b-62e1-47c3-a793-baa804c809b8"),
    ("05-rack-assembly", "05-rack-assembly-glm53-high", "TASK*.events.jsonl",
     "session-af29ccc2-fae7-47fd-8340-f53fb9ffd547"),
    ("06-measure", "recovered-06-measure", "TASK.events.jsonl",
     "session-c1804e17-cd5f-4c28-ae87-a89ee380e13b"),
]


def ctok(chars):
    return math.ceil(chars / CPT)


def j(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def read_session(session_id):
    dirname = session_id if session_id.startswith("session-") else "session-" + session_id
    hits = glob.glob(os.path.join(SESSIONS, "*", dirname, "session.v4.jsonl.zstd"))
    if not hits:
        return None, None
    raw = subprocess.run(["zstd", "-dc", "--", hits[0]], capture_output=True, check=True).stdout
    entries = []
    for line in raw.decode("utf-8", "replace").splitlines():
        if line.strip():
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return hits[0], entries


def read_events(globpat):
    steps = []
    for f in sorted(glob.glob(os.path.join(BENCH, globpat))):
        for line in open(f, encoding="utf-8"):
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if o.get("type") == "status" and o.get("phase") == "step_end":
                u = o.get("usage") or {}
                steps.append({
                    "turn": o.get("turn"), "step": o.get("step"),
                    "ctx": u.get("inputTokens", 0) + u.get("cacheReadTokens", 0),
                    "out": u.get("outputTokens", 0),
                    "total": u.get("totalTokens", 0),
                })
    return steps


def block_prices(blocks, owner):
    """按 dsh-token-meter 的规则计价并归类（token 数，不是字符）。"""
    parts = collections.Counter()
    for b in blocks:
        t = b.get("type")
        if t == "reasoning":
            parts["reasoning"] += ctok(len(b.get("text", ""))) + OVERHEAD
        elif t == "text":
            parts["text:" + owner] += ctok(len(b.get("text", ""))) + OVERHEAD
        elif t == "tool-call":
            parts["tool-call"] += ctok(len(b.get("name", ""))) + ctok(len(b.get("arguments", ""))) + OVERHEAD
        elif t == "image":
            parts["image"] += 1
        else:
            parts["text:tool"] += OVERHEAD + ctok(len(j(b)))
    return parts


def analyse(level, run, evglob, sid):
    steps = read_events(os.path.join(run, evglob))
    N = len(steps)
    ctx_total = sum(s["ctx"] for s in steps)
    billed = sum(s["total"] for s in steps)
    peak = max((s["ctx"] for s in steps), default=0)

    path, entries = read_session(sid)
    if not entries:
        return {"level": level, "error": "session not found"}

    tools = None
    cum = collections.Counter()
    charged = collections.Counter()          # 精确重读贡献（启发式 token）
    img_weighted = 0
    images = []
    calls = []
    results = {}
    step = 0
    reasoning_new = 0

    for e in entries:
        typ = e.get("type")
        d = e.get("data") or {}
        if typ == "request/header":
            tools = d.get("header", {}).get("tools") or []
        elif typ == "step/start":
            for k, v in cum.items():
                charged[k] += v
            step += 1
        elif typ == "assistant/message":
            content = d.get("message", {}).get("content", [])
            for k, v in block_prices(content, "assistant").items():
                if k == "image":
                    img_weighted += v
                    continue
                cum[k] += v
                if k == "reasoning":
                    reasoning_new += v
        elif typ == "tool/call":
            v = ctok(len(d.get("name", ""))) + ctok(len(d.get("arguments", ""))) + OVERHEAD
            cum["tool-call"] += v
            calls.append({"callId": d.get("callId"), "name": d.get("name", ""),
                          "args": d.get("arguments", ""), "step": step})
        elif typ == "tool/result":
            content = d.get("message", {}).get("content", [])
            for k, v in block_prices(content, "tool").items():
                if k == "image":
                    img_weighted += v
                    continue
                cum[k] += v
            cid = d.get("toolCallId") or (d.get("message") or {}).get("toolCallId")
            results[cid] = j(content)[:6000]
            for b in content:
                if b.get("type") == "image":
                    images.append({"step": step, "owner": "tool-result",
                                   "att": b.get("attachment") or {},
                                   "offloaded": bool(b.get("offloaded"))})
        elif typ == "user/message":
            content = d.get("content", [])
            for k, v in block_prices(content, "user").items():
                if k == "image":
                    img_weighted += v
                    continue
                cum[k] += v
            for b in content:
                if b.get("type") == "image":
                    images.append({"step": step, "owner": "user-message",
                                   "att": b.get("attachment") or {}})
        elif typ == "system/message":
            for k, v in block_prices((d.get("message") or {}).get("content", []), "system").items():
                if k != "image":
                    cum[k] += v

    P = ctok(len(j(tools))) + OVERHEAD if tools else 0
    static = N * P
    recon_nonimg = static + sum(charged.values())
    # 图片的重读次数：在第 k 步进入的内容被第 k+1..N 步各读一次
    img_weighted = sum(max(N - i["step"], 0) for i in images)

    # 图片重读次数已按 step 标记；Δ 法：含图步 vs 不含图步
    img_per_step = collections.Counter(i["step"] for i in images)
    with_img, no_img = [], []
    prev = None
    for s in steps:
        if prev is not None:
            dctx = s["ctx"] - prev["ctx"]
            if s["ctx"] > 0 and prev["ctx"] > 0 and dctx > 0:
                k = s["step"] - 1
                (with_img if img_per_step.get(k, 0) == 1 else no_img).append(dctx)
        prev = s

    return {
        "level": level, "run": run, "sessionPath": path,
        "steps": N, "billed": billed, "ctx_total": ctx_total, "peak": peak,
        "P": P, "static": static, "recon_nonimg": recon_nonimg,
        "charged": dict(charged), "img_weighted": img_weighted,
        "reasoning_new": reasoning_new,
        "delta_with_img": float(np.median(with_img)) if with_img else None,
        "delta_no_img": float(np.median(no_img)) if no_img else None,
        "n_with_img": len(with_img), "n_no_img": len(no_img),
        "images": {
            "count": len(images),
            "unique": len({i.get("att", {}).get("attachmentId") for i in images if i.get("att")}),
            "offloaded": sum(1 for i in images if i.get("offloaded")),
            "bytes": sum(int(i.get("att", {}).get("bytes") or 0) for i in images),
            "by_owner": dict(collections.Counter(i["owner"] for i in images)),
            "dims": dict(collections.Counter(
                f"{i['att'].get('width')}x{i['att'].get('height')}" for i in images if i.get("att"))),
        },
        "calls": len(calls),
        "dups": _dedup(calls, results),
        "tools": _tool_rows(tools),
    }


def _dedup(calls, results):
    seen = {}
    dups = []
    for c in calls:
        try:
            key = (c["name"], j(json.loads(c["args"])))
        except Exception:
            key = (c["name"], c["args"])
        if key in seen:
            dups.append((c, seen[key]))
        else:
            seen[key] = c
    groups = collections.Counter()
    for c, _ in dups:
        try:
            key = (c["name"], j(json.loads(c["args"])))
        except Exception:
            key = (c["name"], c["args"])
        groups[key] += 1
    false_hits = sum(1 for c, first in dups if results.get(c["callId"]) != results.get(first["callId"]))

    def rw(x):
        if isinstance(x, float):
            return round(x, 2)
        if isinstance(x, list):
            return [rw(v) for v in x]
        if isinstance(x, dict):
            return {k: rw(v) for k, v in x.items()}
        return x

    seen_r = set()
    rounded = 0
    for c in calls:
        try:
            key = (c["name"], j(rw(json.loads(c["args"]))))
        except Exception:
            key = (c["name"], c["args"])
        if key in seen_r:
            rounded += 1
        else:
            seen_r.add(key)
    return {
        "count": len(dups), "false_hits": false_hits, "rounded": rounded,
        "groups": [{"tool": k[0], "count": v, "args": k[1][:180]} for k, v in groups.most_common(8)],
    }


def _tool_rows(tools):
    if not tools:
        return []
    return [{"name": t.get("name"), "tok": ctok(len(j(t))),
             "desc": ctok(len(t.get("description", ""))),
             "params": ctok(len(j(t.get("parameters", {})))),
             "chars": len(j(t))} for t in tools]


def main():
    as_json = "--json" in sys.argv
    rows = [analyse(*r) for r in RUNS]
    fit = [r for r in rows if "recon_nonimg" in r]

    A = np.array([[r["recon_nonimg"], r["img_weighted"]] for r in fit], float)
    y = np.array([r["ctx_total"] for r in fit], float)
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    alpha, c_img = float(coef[0]), float(coef[1])
    if c_img <= 0:
        c_img = 0.0

    for r in fit:
        r["img_tokens"] = r["img_weighted"] * c_img
        r["alpha"] = alpha
        denom = r["ctx_total"] or 1
        r["share"] = {"schema": r["static"] * alpha / denom, "image": r["img_tokens"] / denom}
        for k in ("reasoning", "tool-call", "text:assistant", "text:tool", "text:user", "text:system"):
            r["share"][k] = r["charged"].get(k, 0) * alpha / denom

    if as_json:
        print(json.dumps({"rows": rows, "fit": {"alpha": alpha, "img_tokens": c_img}},
                         ensure_ascii=False, indent=1))
        return

    print(f"全局拟合：α(启发式→服务商) = {alpha:.3f}   图片 = {c_img:.0f} tok/张")
    print("对照：dsh 的 pi-ai 启发式按 1200 tok/张 计；token-meter 只算引用 JSON（约 40）\n")

    h = "{:<17}{:>5}{:>7}{:>9}{:>8}{:>7}{:>6}{:>6}"
    print(h.format("题", "步", "P", "Σtotal", "schema", "图片%", "张数", "唯一"))
    print("-" * 66)
    agg = collections.Counter()
    for r in fit:
        print(h.format(r["level"], r["steps"], r["P"], f"{r['billed']/1e6:.2f}M",
                       f"{r['static']/1e6:.2f}M", f"{r['share']['image']*100:.0f}%",
                       r["images"]["count"], r["images"]["unique"]))
        for k in ("billed", "ctx_total", "static", "img_tokens", "img_weighted"):
            agg[k] += r[k]
        for k, v in r["share"].items():
            agg["sh_" + k] += v * r["ctx_total"]
        agg["img_count"] += r["images"]["count"]
        agg["img_unique"] += r["images"]["unique"]
        agg["dups"] += r["dups"]["count"]
        agg["false"] += r["dups"]["false_hits"]
        agg["calls"] += r["calls"]
        agg["steps"] += r["steps"]
    print("-" * 66)
    print(h.format("合计", agg["steps"], "", f"{agg['billed']/1e6:.2f}M",
                   f"{agg['static']/1e6:.2f}M",
                   f"{agg['img_tokens']/agg['ctx_total']*100:.0f}%",
                   agg["img_count"], agg["img_unique"]))

    print("\n== 每步重读的构成（Σ input+cacheRead；α 校正后归一到实测总量）==")
    denom = agg["ctx_total"]
    for k in ("reasoning", "tool-call", "image", "text:tool",
              "text:assistant", "text:user", "text:system", "schema"):
        v = agg.get("sh_" + k, 0)
        print(f"  {k:<15}{v/1e6:>8.2f}M{v/denom*100:>7.1f}%")
    print(f"  {'合计':<15}{denom/1e6:>8.2f}M{100:>7.1f}%")
    print(f"  （计费口径 Σtotal = {agg['billed']/1e6:.2f}M，含 output）")

    print("\n== 图片单价：两条独立估计 ==")
    print(f"  全局残差拟合（7 题）：c = {c_img:.0f} tok/张，α = {alpha:.3f}")
    for r in fit:
        if r["delta_with_img"] and r["delta_no_img"]:
            print(f"  {r['level']:<18} 含图步Δ中位 {r['delta_with_img']:>7.0f}（n={r['n_with_img']:>3}）"
                  f"  无图步Δ中位 {r['delta_no_img']:>7.0f}（n={r['n_no_img']:>3}）"
                  f"  差 {r['delta_with_img']-r['delta_no_img']:>+7.0f}")
    print(f"  dsh 启发式：{IMG_TOK_HEURISTIC} tok/张")

    print("\n== 图片明细 ==")
    for r in fit:
        i = r["images"]
        print(f"  {r['level']:<18}{i['count']:>4}张 唯一{i['unique']:>4} {i['bytes']/1e6:>5.2f}MB "
              f"offload={i['offloaded']:>3}  {i['dims']}")

    print("\n== 去重 ==")
    print(f"  调用 {agg['calls']} 次，参数完全相同的重复 {agg['dups']} 次；"
          f"其中 {agg['false']} 次**返回并不相同**（缓存会给出过期答案）")
    for r in fit:
        if r["dups"]["groups"]:
            print(f"  -- {r['level']} 重复 {r['dups']['count']}/{r['calls']}，"
                  f"假命中 {r['dups']['false_hits']}，round2 多命中 {r['dups']['rounded']}")
            for g in r["dups"]["groups"][:4]:
                print(f"     {g['count']:>3}× {g['tool']} {g['args'][:80]}")

    print("\n== 工具表逐字段（03 的 header，按 token 降序）==")
    r3 = [r for r in fit if r["level"] == "03-microscope"][0]
    for t in sorted(r3["tools"], key=lambda x: -x["tok"])[:18]:
        print(f"  {t['tok']:>5} tok  desc={t['desc']:>4} params={t['params']:>5}  {t['name']}")


if __name__ == "__main__":
    main()
