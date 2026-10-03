from openscad import *
import math

# 法兰盘:过程式打孔 —— 逐个 fold 合并
part = cylinder(r=30, h=8)
for i in range(6):
    a = i * math.pi / 3
    part = part - translate([22*math.cos(a), 22*math.sin(a), -1])(cylinder(r=3, h=10))
part = part - cylinder(r=8, h=10)
show(part)
