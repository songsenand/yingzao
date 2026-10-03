import math
from openscad import *

def hole(part, r, h, x, y):
    return part - translate(cylinder(r=r, h=h), [x, y, -1])

def flange(od=60, bore=16, thickness=8, holes=6, bolt_circle=44, bolt_d=6):
    part = cylinder(r=od/2, h=thickness) - cylinder(r=bore/2, h=thickness*2)
    for i in range(holes):
        a = 2*math.pi*i/holes
        part = hole(part, bolt_d/2, thickness*2, bolt_circle/2*math.cos(a), bolt_circle/2*math.sin(a))
    print(f"DATUM|center|0,0,{thickness/2}")
    print(f"DATUM|bolt_p0|{bolt_circle/2},0,{thickness/2}")
    return part

part = flange()
show(part)
