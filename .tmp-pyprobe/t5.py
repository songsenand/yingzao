import json, math, os
from openscad import *
spec = json.loads('{"teeth": 12, "r": 20}')
part = cylinder(r=spec["r"], h=5)
for i in range(spec["teeth"]):
    a = 2*math.pi*i/spec["teeth"]
    tooth = translate(cube([6,3,5]), [spec["r"]*math.cos(a)-3, spec["r"]*math.sin(a)-1.5, 0])
    part = part + tooth
if os.environ.get("THICK"): part = scale([1,1,2], part)
show(part)
