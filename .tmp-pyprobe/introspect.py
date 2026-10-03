from openscad import *
c = cube(5)
t = translate([1,2,3])
print("type(translate(v)) =", type(t), "repr:", repr(t)[:80])
print("type(cube(5)) =", type(c))
print("translate two-arg:", type(translate([1,2,3], c)))
import openscad
names = [n for n in dir(openscad) if not n.startswith('_')]
print("openscad module exports:", names)
