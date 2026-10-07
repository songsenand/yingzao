#!/usr/bin/env python3
"""Purify a reference photo for the bench, and derive its landmarks.

Why this exists
---------------
The user-supplied microscope photo (`显微镜参考图.png`, an AI de-turreted variant
of the microscope5 reference) carries a third-party AI watermark in the lower
right ("千问"). The watermark is light grey on a white background, so it survives
a naive "not white" threshold as ~122 tiny disconnected specks — and it drags the
subject bounding box out to y=990, turning the measured aspect ratio from 1.871
into 1.260. Any landmark set derived without removing it is wrong.

What it does
------------
1. Threshold "not background".
2. Keep the LARGEST connected component (the machine); drop every speck.
3. Crop to that component plus a margin. The crop excludes the watermark by
   construction, so no inpainting is needed.
4. Re-derive the ten-band normalized width profile on the purified image and
   write `landmarks.json` next to it.

The profile is normalized by the subject's own pixel height, so it is invariant
to crop and resolution — which is what makes it comparable against a render.

Usage
-----
    python3 purify-reference.py <in.png> <out.png>

Writes `<out.png>` and `<out dir>/landmarks.json`.

Requires: Pillow, numpy, scipy.
"""

import json
import os
import sys

import numpy as np
from PIL import Image

try:
    from scipy import ndimage as ndi
except ImportError:  # pragma: no cover
    sys.exit("scipy is required: pip install scipy")

# Band 4 (40%-50% of subject height) is where the objective turret sat in the
# original photo. The bench tells the agent NOT to build a turret, so this band
# is excluded from the fidelity metric: scoring it would penalise the model for
# doing what it was told. See docs/DECISION-LOG.md, 2026-10-05.
TURRET_BAND = 4
BACKGROUND_SUM = 720   # sum of RGB above this is "white-ish"
BACKGROUND_STD = 12    # per-pixel channel spread above this is "coloured"
MARGIN_PX = 60
BANDS = 10


def subject_mask(rgb: np.ndarray) -> np.ndarray:
    """Boolean mask of the machine, watermark specks removed."""
    raw = (rgb.sum(axis=2) < BACKGROUND_SUM) | (rgb.std(axis=2) > BACKGROUND_STD)
    labels, count = ndi.label(raw)
    if count == 0:
        raise SystemExit("no subject found — is the background really white?")
    sizes = ndi.sum(np.ones_like(labels), labels, range(1, count + 1))
    main = int(np.argmax(sizes)) + 1
    dropped = count - 1
    if dropped:
        print(f"  dropped {dropped} disconnected speck(s) (watermark / noise)")
    return labels == main


def profile(mask: np.ndarray) -> tuple[int, int, list[float]]:
    """(w, h, ten normalized band widths) for the mask's bounding box."""
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
    return w, h, widths


def main() -> int:
    if len(sys.argv) != 3:
        return int(bool(sys.stderr.write(__doc__))) or 2
    src, dst = sys.argv[1], sys.argv[2]

    img = Image.open(src).convert("RGB")
    rgb = np.asarray(img).astype(int)
    mask = subject_mask(rgb)

    ys, xs = np.nonzero(mask)
    x0, y0 = max(0, int(xs.min()) - MARGIN_PX), max(0, int(ys.min()) - MARGIN_PX)
    x1, y1 = min(img.width, int(xs.max()) + 1 + MARGIN_PX), min(img.height, int(ys.max()) + 1 + MARGIN_PX)
    crop_mask = mask[y0:y1, x0:x1]

    # Guard: the crop must not still contain non-subject specks. If the watermark
    # ever moves inside the margin, this fails loudly instead of shipping a
    # contaminated reference.
    if crop_mask.sum() != mask.sum():
        return int(bool(sys.stderr.write(
            f"REFUSING: crop still contains {int(mask.sum() - crop_mask.sum())} "
            f"non-subject pixel(s); widen the margin handling or inpaint instead\n"
        ))) or 1

    w, h, prof = profile(mask)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    img.crop((x0, y0, x1, y1)).save(dst)

    landmarks = {
        "schemaVersion": 1,
        "subject": "单目复式显微镜（参考图，物镜转换器已由用户从原图移除）",
        "source": os.path.basename(src),
        "purifiedBy": "examples/bench/tools/purify-reference.py",
        "purifiedTo": os.path.basename(dst),
        "method": {
            "mask": f"not-background: sum(RGB) >= {BACKGROUND_SUM} and channel spread <= {BACKGROUND_STD}",
            "component": "largest connected component (watermark specks dropped)",
            "marginPx": MARGIN_PX,
            "droppedSpecks": True,
        },
        "measuredOnSource": {
            "objectWPx": w,
            "objectHPx": h,
            "aspectHW": round(h / w, 3),
        },
        "silhouetteProfile": {
            "bands": BANDS,
            "normalizedBy": "subject pixel height",
            "values": prof,
            "excludedBands": [TURRET_BAND],
            "excludedReason": (
                "band 4 (40%-50% height) is the objective-turret band; the prompt "
                "forbids a turret, so scoring this band would penalise compliance"
            ),
        },
        "howToUse": (
            "Render front and side at the frozen camera (azimuth ≈ 35°, elevation ≈ 15°) "
            "with an empty background, threshold the same way, take the ten-band profile, "
            "drop the excluded bands, and compare L1 distance against this profile."
        ),
    }
    out_json = os.path.join(os.path.dirname(os.path.abspath(dst)), "landmarks.json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(landmarks, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"  purified -> {dst}  ({x1 - x0}×{y1 - y0} px, margin {MARGIN_PX})")
    print(f"  subject  -> {w}×{h} px, H/W = {h / w:.3f}")
    print(f"  profile  -> {prof}")
    print(f"  landmarks-> {out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
