from openscad import *

# procedural: python loop generating holes
holes = [translate([x, 5, -1])(cylinder(r=2, h=12)) for x in range(10, 50, 10)]
part = cube([60, 10, 10]) - holes
output(part)
