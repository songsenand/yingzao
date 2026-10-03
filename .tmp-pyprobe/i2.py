from openscad import *
import openscad
c = cube(5)
print("two-arg translate:", type(translate([1,2,3], c)))
print("exports:", sorted(n for n in dir(openscad) if not n.startswith('_')))
