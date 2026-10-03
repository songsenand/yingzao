from openscad import *
c = cube(5)
t1 = translate([1,2,3])
print("one-arg result:", type(t1), "len:", len(t1))
print("elem type:", type(t1[0]))
print("dir(PyOpenSCAD):", [n for n in dir(t1[0]) if not n.startswith('__')])
