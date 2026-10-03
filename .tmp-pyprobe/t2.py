from openscad import *

# 法兰盘:python 循环打孔,验证过程式生成
part = cylinder(r=30, h=8) - [translate([x, 0, -1])(cylinder(r=3, h=10)) for x in (20, -20, 0)] \
                            - [translate([0, y, -1])(cylinder(r=3, h=10)) for y in (20, -20)]
show(part)
