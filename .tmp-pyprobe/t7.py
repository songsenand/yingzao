from openscad import *
base = cube([20,20,5]); bump = translate(cube([5,5,5]), [7,7,5])
def tryit(desc, fn):
    try:
        g = fn(); show(g); print(desc, "OK")
    except Exception as e:
        print(desc, "fail:", e)
tryit("union(a,b)", lambda: union(base, bump))
tryit("a.union(b)", lambda: base.union(bump))
tryit("a | [b]", lambda: base | [bump])
tryit("group([a,b])", lambda: group([base, bump]))
