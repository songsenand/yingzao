"""Acceptance for `support_map`: does it judge a hang by MASS, not by area?

Three synthetic, watertight cases (built here, not stored):
  big     30x30 plate on a 4x4 post   -> two ~3 g cantilevers -> MUST be reported
  ledge   3 mm ledge on a wall        -> ~0.015 g           -> MUST be silent
  bridge  8 mm unsupported span       -> bridged (<=10 mm)  -> MUST be silent
Run:  .tmp-cad-runtime/venv/bin/python scripts/accept-support.py
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import trimesh
from shapely.geometry import Polygon

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYBIN = sys.executable
WORKER = os.path.join(ROOT, 'python', 'cad_worker', 'worker.py')

fails = 0
def check(ok, label, detail=''):
    global fails
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ''))

def extrude(pts, depth, path):
    mesh = trimesh.creation.extrude_polygon(Polygon(pts), depth)
    mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    mesh.export(path)

def run_support(path, **kw):
    params = {'path': path, 'dxMm': 1.0, **kw}
    frame = json.dumps({'id': 1, 'op': 'support_map', 'params': params}) + '\n'
    p = subprocess.run([PYBIN, '-I', WORKER], input=frame, capture_output=True, text=True, cwd=ROOT, timeout=600)
    for line in p.stdout.splitlines():
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if 'result' in msg:
            return msg['result']
        if msg.get('ok') is False:
            raise SystemExit(f"worker error: {msg.get('error')}")
    raise SystemExit(f"no result frame; stderr={p.stderr[-400:]}")

tmp = tempfile.mkdtemp(prefix='accept-support-')
big = os.path.join(tmp, 'big.stl')
extrude([(-2, 0), (2, 0), (2, 10), (15, 10), (15, 20), (-15, 20), (-15, 10), (-2, 10)], 30, big)
ledge = os.path.join(tmp, 'ledge.stl')
extrude([(0, 0), (2, 0), (2, 40), (5, 40), (5, 43), (0, 43)], 3, ledge)
bridge = os.path.join(tmp, 'bridge.stl')
extrude([(-8, 0), (-4, 0), (-4, 20), (4, 20), (4, 0), (8, 0), (8, 22), (-8, 22)], 20, bridge)

r = run_support(big)
check(len(r['regions']) >= 1, 'a hanging plate is reported (mass, not area)', f"{len(r['regions'])} region(s), total {r['totals']['massG']} g")
check(all(g['massG'] >= r['minMassG'] for g in r['regions']), 'and only regions above the declared mass threshold')
check(all(g['spanMm'] >= 20 for g in r['regions']), 'with a span that says how far it reaches', str([g['spanMm'] for g in r['regions']]))

r = run_support(ledge)
check(len(r['regions']) == 0, 'a 3 mm ledge is silent (0.015 g is free)', f"{r['totals']['massG']} g")

r = run_support(bridge)
check(len(r['regions']) == 0, 'an 8 mm span is bridged, not supported', f"{r['totals']['bridgedCells']} bridged cells")
check(r['totals']['bridgedCells'] > 0, 'and it says so instead of dropping the cells silently')

# A tighter bridge limit must make the same span report: the threshold is declared, not baked in.
# Both declared knobs must bite, INDEPENDENTLY: lowering the bridge limit makes the span
# unbridgeable, but the span is only 0.47 g, so it still must NOT be reported until the
# mass threshold is lowered too. That is the design working (mass decides, bridging only
# decides reachability), and it is why the test sets both.
r = run_support(bridge, bridgeMaxMm=4.0)
check(len(r['regions']) == 0, 'lowering only bridgeMaxMm is not enough: 0.47 g is still under the mass floor', f"{len(r['regions'])} region(s)")
r = run_support(bridge, bridgeMaxMm=4.0, minMassG=0.1)
check(len(r['regions']) >= 1, 'unbridgeable + above a lowered mass floor -> reported', f"{len(r['regions'])} region(s), {r['totals']['massG']} g")

print('\nOK' if fails == 0 else f'\n{fails} FAILURE(S)')
sys.exit(1 if fails else 0)
