from openscad import *
holes = [translate([x,0,-1])(cylinder(r=2,h=12)) for x in range(10,50,10)]
try:
    part = cube([60,10,10]) - union(holes)
    show(part)
except Exception as e:
    print("union(list) failed:", e)
    part = cube([60,10,10])
    for h in holes: part = part - h
    show(part)
