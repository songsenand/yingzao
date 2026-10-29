"""Self-test driver for the G2 datum direction validation (2026-10-29).

The p/dir positional swap (`datum_axis("rail", [0,0,1], [10,0,205])`) compiles
silently in OpenSCAD and landed in datums.json unflagged — roberval-balance
v048 bottom_axis was point=[0,1,0] dir=[0,0,140] and four parts needed
set_datums repair. This tests the READER half (`op_scad_parse_output`): the
zero-direction case is an ERROR, the swap signature is a WARNING, and honest
input stays clean. `accept-set-datums-validation.mjs` covers the host side.

    python scripts/datum-axis-selftest.py   (the provisioned runtime python)
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python", "cad_worker"))
import worker  # noqa: E402

OUT = {}
failures = 0


def check(ok, label, detail=""):
    global failures
    if not ok:
        failures += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label}{('  — ' + detail) if detail else ''}")


def parse(raw):
    return worker.op_scad_parse_output({"raw": raw})


# 1. the swap signature: short point, huge dir, no other coordinates — WARNING
swapped = 'ECHO: "__DATUM_AXIS__bottom_axis=0.000,1.000,0.000|0.000,0.000,140.000"\n'
r = parse(swapped)
warned = any("swapped p/dir" in w for w in r["warnings"])
OUT["swap"] = {"warnings": r["warnings"], "errors": r["errors"]}
check(warned, "swapped p/dir (point=[0,1,0] dir=[0,0,140], the roberval v048 case) warns")
check(r["errors"] == [], "swap case is a warning, not an error")
check(len(r["datumSet"]["axes"]) == 1, "the swapped datum still parses (values preserved verbatim)")

# 2. zero direction — ERROR (an axis with no direction is never usable)
zero = 'ECHO: "__DATUM_AXIS__rail=10.000,0.000,205.000|0.000,0.000,0.000"\n'
r = parse(zero)
check(any("[0, 0, 0]" in e for e in r["errors"]), "zero dir is a compile ERROR")
check(not any("swapped" in w for w in r["warnings"]), "zero dir does not ALSO warn as a swap")

# 3. honest input: coordinates O(100), unit dirs — clean
honest = (
    'ECHO: "__DATUM__pivot=10.000,0.000,205.000"\n'
    'ECHO: "__DATUM_AXIS__axis_a=10.000,0.000,205.000|0.000,1.000,0.000"\n'
    'ECHO: "__DATUM_AXIS__axis_b=-80.000,0.000,140.000|1.000,0.000,0.000"\n'
    'ECHO: "__DATUM_CYL__bore=0.000,0.000,0.000|0.000,0.000,1.000|4.000"\n'
    'ECHO: "__DATUM_PLANE__face=0.000,-10.000,45.000|0.000,-1.000,0.000"\n'
)
r = parse(honest)
OUT["honest"] = {"warnings": r["warnings"], "errors": r["errors"]}
check(r["warnings"] == [] and r["errors"] == [], "honest input (unit dirs, real coordinates) stays clean")

# 4. documented false positive: an intentional endpoint-form dir with a tiny point
#    warns (accepted: the reply says "if the magnitude is intentional, ignore")
endpoint_form = 'ECHO: "__DATUM_AXIS__tall=0.000,0.000,1.000|0.000,0.000,140.000"\n'
r = parse(endpoint_form)
check(any("swapped p/dir" in w for w in r["warnings"]), "endpoint-form dir with tiny point warns (documented tradeoff)")

# 5. model scale CANNOT disambiguate: a long dir in a large-coordinate model has
#    exactly the v048 signature, so it warns (accepted over-trigger — the warning
#    says "if the magnitude is intentional, ignore"). A missed swap costs more.
tall_model = (
    'ECHO: "__DATUM__foot=-85.000,45.000,0.000"\n'
    'ECHO: "__DATUM__top=0.000,0.000,205.000"\n'
    'ECHO: "__DATUM_AXIS__z_axis=0.000,0.000,0.000|0.000,0.000,140.000"\n'
)
r = parse(tall_model)
check(
    any("swapped p/dir" in w for w in r["warnings"]),
    "long dir with tiny point warns even in a large model (indistinguishable from v048)",
)

# 6. plane normal swap is caught by the same rule
plane_swap = 'ECHO: "__DATUM_PLANE__face=0.000,0.000,1.000|0.000,-10.000,45.000"\n'
r = parse(plane_swap)
check(any("swapped p/dir" in w for w in r["warnings"]), "swapped plane p/normal warns via the same rule")

print(json.dumps(OUT))
sys.exit(1 if failures else 0)
