import math
from openscad import *

part = cylinder(r=30, h=8) - cylinder(r=8, h=10)   # 盘 + 中心孔
for i in range(6):
    a = i * math.pi / 3
    part = part - translate(cylinder(r=3, h=10), [22*math.cos(a), 22*math.sin(a), -1])
show(part)
