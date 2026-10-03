import sys, struct
from openscad import *
def p(*a): print(*a); sys.stdout.flush()

c = cube(5)
for desc, g in [
    ("translate(c, v)",  translate(c, [10,0,0])),
    ("translate(child_list)", translate([c], [10,0,0])),
]:
    try:
        show(g)
        p(desc, "-> OK", type(g).__name__)
        break
    except Exception as e:
        p(desc, "-> fail:", e)
