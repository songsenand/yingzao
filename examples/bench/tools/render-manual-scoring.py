#!/usr/bin/env python3
"""把人工评分材料渲染成一张长图。

输入：一个 manifest JSON（sections 列表，每节含 title 与 blocks）。
输出：一张竖向长 PNG。

block 类型：
  kv      {"kind":"kv","items":[[k,v],...]}            两列键值
  text    {"kind":"text","body":"..."}                 段落（保留换行，自动折行）
  items   {"kind":"items","items":[{"head":"...","body":"...","tag":"PASS|FAIL|UNKNOWN|..."}]}
  image   {"kind":"image","path":"...","caption":"...","max_h":int}
  gap     {"kind":"gap"}                               分隔
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

W = 1560
PAD = 36
FONT_R = "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc"
FONT_B = "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc"
if not __import__("os").path.exists(FONT_R):
    FONT_R = "/usr/share/fonts/noto-cjk/NotoSansCJK-DemiLight.ttc"
    FONT_B = FONT_R

F_TITLE = ImageFont.truetype(FONT_B, 34)
F_H2 = ImageFont.truetype(FONT_B, 26)
F_BODY = ImageFont.truetype(FONT_R, 22)
F_SMALL = ImageFont.truetype(FONT_R, 19)
F_MONO = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 19) if __import__("os").path.exists("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf") else F_SMALL

TAG_COLOR = {
    "PASS": "#0a7d32", "FAIL": "#b3261e", "UNKNOWN": "#8a6d00",
    "SKIP": "#5f6368", "INFO": "#1a56b0", "N/A": "#5f6368",
}

def wrap(draw, text, font, maxw):
    lines = []
    for raw in (text or "").split("\n"):
        if not raw:
            lines.append("")
            continue
        cur = ""
        for ch in raw:
            trial = cur + ch
            if draw.textlength(trial, font=font) <= maxw or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = ch
        lines.append(cur)
    return lines

def render(manifest, out_path):
    sections = manifest["sections"]
    # 预估高度
    probe = Image.new("RGB", (W, 100))
    d = ImageDraw.Draw(probe)
    total_h = PAD
    for sec in sections:
        total_h += 74  # section title band
        for b in sec.get("blocks", []):
            k = b["kind"]
            maxw = W - 2 * PAD
            if k == "kv":
                for kk, vv in b["items"]:
                    total_h += len(wrap(d, f"{kk}：{vv}", F_BODY, maxw)) * 32 + 6
            elif k == "text":
                for ln in b["body"].split("\n"):
                    font = F_MONO if b.get("mono") else F_BODY
                    total_h += len(wrap(d, ln, font, maxw)) * (30 if not b.get("mono") else 26)
                total_h += 10
            elif k == "items":
                for it in b["items"]:
                    head = it.get("head", "")
                    tag = it.get("tag", "")
                    prefix = f"[{tag}] " if tag else ""
                    total_h += len(wrap(d, prefix + head, F_BODY, maxw)) * 32
                    if it.get("body"):
                        total_h += len(wrap(d, it["body"], F_SMALL, maxw - 24)) * 27 + 8
                    total_h += 6
            elif k == "image":
                try:
                    im = Image.open(b["path"])
                    ratio = min((b.get("max_w", 720)) / im.width, (b.get("max_h", 560)) / im.height, 1.0)
                    total_h += int(im.height * ratio) + (30 if b.get("caption") else 0) + 12
                except Exception:
                    total_h += 40
            elif k == "gap":
                total_h += 26
        total_h += 18
    total_h += PAD

    img = Image.new("RGB", (W, int(total_h)), "#ffffff")
    d = ImageDraw.Draw(img)
    y = PAD
    for sec in sections:
        # section band
        d.rectangle([0, y, W, y + 56], fill="#102a43")
        d.text((PAD, y + 10), sec["title"], font=F_TITLE, fill="#ffffff")
        y += 68
        for b in sec.get("blocks", []):
            k = b["kind"]
            maxw = W - 2 * PAD
            if k == "kv":
                for kk, vv in b["items"]:
                    for ln in wrap(d, f"{kk}：{vv}", F_BODY, maxw):
                        d.text((PAD, y), ln, font=F_BODY, fill="#1f2933")
                        y += 32
                    y += 6
            elif k == "text":
                col = "#243b53" if not b.get("dim") else "#627d98"
                for ln in b["body"].split("\n"):
                    font = F_MONO if b.get("mono") else F_BODY
                    lh = 26 if b.get("mono") else 30
                    for wln in wrap(d, ln, font, maxw):
                        d.text((PAD, y), wln, font=font, fill=col)
                        y += lh
                y += 10
            elif k == "items":
                for it in b["items"]:
                    tag = it.get("tag", "")
                    color = TAG_COLOR.get(tag, "#1f2933")
                    x = PAD
                    if tag:
                        d.rounded_rectangle([x, y - 2, x + 8 * len(tag) + 18, y + 26], 6, outline=color, width=2)
                        d.text((x + 9, y + 1), tag, font=F_SMALL, fill=color)
                        x += 8 * len(tag) + 30
                    for i, ln in enumerate(wrap(d, it.get("head", ""), F_BODY, W - PAD - x)):
                        d.text((x if i == 0 else PAD, y), ln, font=F_BODY, fill="#1f2933")
                        y += 32
                    if it.get("body"):
                        for ln in wrap(d, it["body"], F_SMALL, maxw - 24):
                            d.text((PAD + 24, y), ln, font=F_SMALL, fill="#52606d")
                            y += 27
                        y += 6
                    y += 6
            elif k == "image":
                try:
                    im = Image.open(b["path"]).convert("RGB")
                    ratio = min((b.get("max_w", 720)) / im.width, (b.get("max_h", 560)) / im.height, 1.0)
                    im = im.resize((int(im.width * ratio), int(im.height * ratio)))
                    d.rectangle([PAD - 1, y - 1, PAD + im.width + 1, y + im.height + 1], outline="#9fb3c8")
                    img.paste(im, (PAD, y))
                    y += im.height + 4
                    if b.get("caption"):
                        for ln in wrap(d, b["caption"], F_SMALL, maxw):
                            d.text((PAD, y), ln, font=F_SMALL, fill="#52606d")
                            y += 26
                    y += 8
                except Exception as e:
                    d.text((PAD, y), f"[图片缺失 {b.get('path')}: {e}]", font=F_SMALL, fill="#b3261e")
                    y += 30
            elif k == "gap":
                d.line([PAD, y + 8, W - PAD, y + 8], fill="#d9e2ec")
                y += 26
        y += 18

    img = img.crop((0, 0, W, int(min(y + PAD, total_h))))
    img.save(out_path, optimize=True)
    print(f"saved {out_path}  {img.width}x{img.height}")

if __name__ == "__main__":
    manifest = json.load(open(sys.argv[1], encoding="utf-8"))
    render(manifest, sys.argv[2])
