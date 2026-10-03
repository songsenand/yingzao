import sys
from openscad import *
def p(*a): print(*a); sys.stdout.flush()
c = cube(5)
p("step1")
t1 = translate([1,2,3])
p("step2 type:", type(t1).__name__)
try:
    p("len:", len(t1))
except Exception as e:
    p("len failed:", e)
p("repr:", repr(t1)[:120])
p("dir:", [n for n in dir(t1) if not n.startswith('_')])
