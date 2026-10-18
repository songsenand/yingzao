#!/usr/bin/env python3
"""Measure the 03-microscope reference image and (re)write landmarks.

The submission image
--------------------
`graders/03-microscope/参考图.png` is a **third-party, openly licensed illustration**
(Pixabay Content License; see `examples/bench/ATTRIBUTION.md`) that this project edits
before use. Like every other third-party asset in the bench it is **materialised, never
committed** — the licensed original is fetched/stored outside the repository, and only
the licence record plus the measurement numbers live in git.

What this script does
---------------------
Measure the installed reference image with the frozen rule (background threshold ->
largest connected component -> ten-band width profile normalised by subject height).

Usage
-----
    python3 make-reference-figure.py                  # rasterise the SVG -> 参考图.png
    python3 make-reference-figure.py --check          # measure only
    python3 make-reference-figure.py --write-landmarks

Requires: Pillow, numpy, scipy, and one of rsvg-convert / inkscape / magick.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image

try:
    from scipy import ndimage as ndi
except ImportError:  # pragma: no cover
    sys.exit("scipy is required: pip install scipy")

HERE = os.path.dirname(os.path.abspath(__file__))
GRADER_DIR = os.path.join(os.path.dirname(HERE), "graders", "03-microscope")
DEFAULT_OUT = os.path.join(GRADER_DIR, "参考图.png")
DEFAULT_LANDMARKS = os.path.join(GRADER_DIR, "landmarks.json")

BACKGROUND_MIN = 250      # 三通道都 >= 250 才算背景（白描风格图：筒体近白但非纯白）
BANDS = 10
CANVAS = 1024

# Measured on the original photo (显微镜参考图.png) on 2026-10-05:
# subject 410 x 767 px, H/W 1.871, ten-band profile normalised by subject height.
PHOTO_BBOX = (410, 767)
PHOTO_PROFILE = [0.104, 0.153, 0.289, 0.349, 0.360, 0.510, 0.512, 0.507, 0.503, 0.253]




def _openscad() -> str:
    env = os.environ.get("CAD_OPENSCAD_BIN")
    if env and os.path.exists(env):
        return env
    bundled = os.path.join(os.path.dirname(HERE), "..", "..", "bin", "squashfs-root", "usr", "bin", "openscad")
    bundled = os.path.abspath(bundled)
    if os.path.exists(bundled):
        return bundled
    found = shutil.which("openscad")
    if found:
        return found
    sys.exit("OpenSCAD not found: set CAD_OPENSCAD_BIN or install openscad")


def render_model(out_path: str) -> None:
    """Retired: the 2026-10-16 3D-model route was dropped.

    The reference image is now an openly licensed third-party illustration that is
    edited (turret / mirror / condenser removed, single objective kept, LED added) and
    materialised outside the repository. Put that file at `--out`, then re-run this
    script to refresh `landmarks.json`.
    """
    if not os.path.exists(out_path):
        sys.exit(f"reference image missing: {out_path}\n"
                 "materialise the licensed original (see examples/bench/ATTRIBUTION.md) first")


def subject_mask(rgb: np.ndarray) -> np.ndarray:
    """Mirror of the 2026-10-05 rule: not-background, largest 4-connected component."""
    raw = rgb.min(axis=2) < BACKGROUND_MIN
    labels, count = ndi.label(raw)
    if count == 0:
        raise SystemExit("no subject found — is the background really white?")
    sizes = ndi.sum(np.ones_like(labels), labels, range(1, count + 1))
    return labels == (int(np.argmax(sizes)) + 1)


def measure(mask: np.ndarray) -> tuple[int, int, list[float], int]:
    ys, xs = np.nonzero(mask)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    w, h = int(x1 - x0 + 1), int(y1 - y0 + 1)
    widths: list[float] = []
    for k in range(BANDS):
        ya = y0 + int(h * k / BANDS)
        yb = y0 + int(h * (k + 1) / BANDS)
        cols = mask[ya:yb].sum(axis=0)
        nz = np.nonzero(cols)[0]
        widths.append(round(float(nz.max() - nz.min() + 1) / h, 3) if len(nz) else 0.0)
    return w, h, widths, int(mask.sum())


def main() -> int:
    ap = argparse.ArgumentParser(description="Rasterise + measure the 03 reference illustration.")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true", help="measure the existing PNG (no rasterise)")
    ap.add_argument("--write-landmarks", action="store_true")
    args = ap.parse_args()

    if not args.check:
        render_model(args.out)
        print(f"measuring {args.out}")

    img = Image.open(args.out).convert("RGBA")
    img = Image.alpha_composite(Image.new("RGBA", img.size, (255, 255, 255, 255)), img).convert("RGB")
    mask = subject_mask(np.asarray(img).astype(int))
    w, h, prof, npx = measure(mask)
    print(f"subject: {w}x{h}  aspect H/W={round(h / w, 3)}  pixels={npx}  (photo {PHOTO_BBOX[0]}x{PHOTO_BBOX[1]})")
    print("band   旧照片   当前参考图   差值（旧照片仅作历史对照，不计分）")
    worst = 0.0
    for k, (ph, fg) in enumerate(zip(PHOTO_PROFILE, prof)):
        d = fg - ph
        worst = max(worst, abs(d))
        print(f"  {k}   {ph:.3f}   {fg:.3f}   {d:+.3f}")
    print(f"（提示）当前参考图与旧照片的十段最大差 {worst:.3f}——两者是不同机型，此数不计分")

    if args.write_landmarks:
        landmarks = {
            "schemaVersion": 3,
            "subject": "单目复式显微镜（本项目自绘技术插图，无物镜转换器）",
            "source": "Pixabay content 34792（Clker-Free-Vector-Images），Pixabay Content License；本项目编辑：删除台下反光镜及支臂",
            "figure": os.path.basename(args.out),
            "whySelfDrawn": (
            "自建路线（手绘 SVG、3D 模型渲染）已停用。现参考图是开放版权现成插画（Pixabay 34792），"
            "本项目只做一处编辑（删反光镜）；素材按题库纪律物化使用、不入库，仓库只留授权登记与测量数字。"
        ),
            "method": {
                "mask": f"not-background: min(RGB) < {BACKGROUND_MIN} (pure-white background)",
                "component": "largest connected component",
                "bands": BANDS,
                "normalizedBy": "subject pixel height",
            },
            "measuredOnFigure": {
                "objectWPx": w,
                "objectHPx": h,
                "aspectHW": round(h / w, 3),
            },
            "measuredOnOldPhotoArchive": {
                "objectWPx": PHOTO_BBOX[0],
                "objectHPx": PHOTO_BBOX[1],
                "aspectHW": round(PHOTO_BBOX[1] / PHOTO_BBOX[0], 3),
            },
            "silhouetteProfile": {
                "bands": BANDS,
                "normalizedBy": "subject pixel height",
                "values": prof,
                "photoValues20261005": PHOTO_PROFILE,
                "excludedBands": [],
                "excludedReason": (
                    "十段全用。2026-10-05 曾排除 band4（40%-50% 高度带），因为当时参考图里有物镜转换器；"
                    "现参考图（Pixabay 34792）天生单物镜、无转换器，排除理由已消失。"
                ),
            },
            "howToUse": (
                "Render front and side at the frozen camera (azimuth ≈ 35°, elevation ≈ 15°) with an "
                "empty background, threshold the same way, take the ten-band profile, drop the excluded "
                "bands, and compare L1 distance against this profile."
            ),
        }
        with open(DEFAULT_LANDMARKS, "w", encoding="utf-8") as fh:
            json.dump(landmarks, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"wrote {DEFAULT_LANDMARKS}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
