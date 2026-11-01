// 复合齿轮 B：10T 小齿轮 + 24T 大齿轮（同一轴）
include <BOSL2/std.scad>
include <BOSL2/gears.scad>
$fn = 64;

BX = 15.6906; BY = 8.1826;
module part() {
  difference() {
    union() {
      translate([BX, BY, 14.2])
        spur_gear(mod=0.7, teeth=10, thickness=2.6, shaft_diam=0, backlash=0.06, gear_spin=14);
      translate([BX, BY, 17.3])
        spur_gear(mod=0.7, teeth=24, thickness=2.6, shaft_diam=0, backlash=0.06, gear_spin=14);
      // 轮毂：小齿轮段收细（r2.8），避免碰到 30T 齿顶
      translate([BX, BY, 12.7]) cylinder(h=2.8, d=5.6);
      translate([BX, BY, 15.5]) cylinder(h=1.9, d=7.0);
    }
    translate([BX, BY, 2.0]) cylinder(h=19, d=3.12);
  }
}
datum_axis("轴B",[15.6906,8.1826,15],[0,0,1]);
datum_cyl("孔",[15.6906,8.1826,15],[0,0,1],1.56);
part();
