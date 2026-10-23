#!/usr/bin/env bash
# Rebuild the three text-engraving demos and print the measured numbers.
#   ./run.sh            # uses the bundled OpenSCAD snapshot
#   CAD_OPENSCAD_BIN=/usr/bin/openscad ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONDONTWRITEBYTECODE=1

OC=${CAD_OPENSCAD_BIN:-../../bin/squashfs-root/usr/bin/openscad}
LIB=../../bin/squashfs-root/usr/lib
if [ -d "$LIB" ]; then export LD_LIBRARY_PATH="$(cd "$LIB" && pwd)${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi

# fontconfig complains about an unwritable cache under a sandbox; glyphs still
# resolve, so drop those lines from the build log.
run() { "$@" 2> >(grep -vE 'Fontconfig|^[[:space:]]+/' >&2); }

echo "== build =="
run "$OC" --backend=Manifold --export-format binstl -o plate.stl plate.scad
run "$OC" --backend=Manifold --export-format binstl -o sphere.stl sphere.scad
run "$OC" --backend=Manifold --enable=textmetrics --export-format binstl -o cylinder.stl cylinder.scad

echo
echo "== renders =="
run "$OC" --backend=Manifold --render --imgsize=1200,520 --camera=0,0,0,58,0,22,240 --colorscheme=Tomorrow -o plate.png plate.scad
run "$OC" --backend=Manifold --enable=textmetrics --render --imgsize=1100,650 --viewall --autocenter --camera=0,0,0,78,0,195,0 --colorscheme=Tomorrow -o cylinder.png cylinder.scad
run "$OC" --backend=Manifold --render --imgsize=800,700 --viewall --autocenter --camera=0,0,0,40,0,25,0 --colorscheme=Tomorrow -o sphere.png sphere.scad

echo
echo "== stl checks =="
for f in plate sphere cylinder; do python3 measure.py "$f.stl"; echo; done

echo "== engraved depth =="
python3 - "$@" <<'PY'
import sys
import numpy as np
from measure import load

# plate: engraved floor sits at 2.5 - 0.8 = 1.70, embossed top at 2.5 + 0.8 = 3.30
pts = load('plate.stl').reshape(-1, 3)
z = pts[:, 2]
engraved = pts[(z > 1.69) & (z < 1.71)]
print(f"plate engraved floor z = {engraved[:,2].mean():.3f} (expected 1.700), max z = {z.max():.3f}")

# cylinder: R=18, D=0.8; engraved copy at x=-30, embossed copy at x=+30
pts = load('cylinder.stl').reshape(-1, 3)
for name, cx in [('engraved', -30.0), ('embossed', 30.0)]:
    dx = pts[:, 0] - cx
    r = np.hypot(dx, pts[:, 1])
    near = r[(np.abs(dx) < 20)]
    print(f"cylinder {name:9s} r_min={near.min():.3f} r_max={near.max():.3f} (R=18, D=0.8)")

# sphere: R=60, D=1.0 -> engraved floor at z = 59.0
pts = load('sphere.stl').reshape(-1, 3)
z = pts[:, 2]
floor = pts[(z > 58.99) & (z < 59.01)]
print(f"sphere engraved floor z = {floor[:,2].mean():.3f} (expected 59.000)")
PY
