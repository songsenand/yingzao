// 风轮：10T 小齿轮 + 竖叶片风轮（C 轴）
include <BOSL2/std.scad>
include <BOSL2/gears.scad>
$fn = 64;

CX = 22.6701; CY = -1.7857;
module part() {
  difference() {
    union() {
      // 轮毂
      translate([CX, CY, 3.6]) cylinder(h=3.1, d=6.0);
      translate([CX, CY, 6.6]) cylinder(h=9.5, d=5.6);
      translate([CX, CY, 15.9]) cylinder(h=0.8, d=6.0);
      // 10T 小齿轮
      translate([CX, CY, 17.3])
        spur_gear(mod=0.7, teeth=10, thickness=2.6, shaft_diam=0, backlash=0.06, gear_spin=354.4);
      // 两片竖叶片，z 7..12，r 2.6..8
      for (a=[0,90]) translate([CX, CY, 7]) rotate([0,0,a])
        translate([2.6, -0.6, 0]) cube([5.4, 1.2, 5.0]);
    }
    translate([CX, CY, 2.0]) cylinder(h=19, d=3.12);
  }
}
datum_axis("轴C",[22.6701,-1.7857,10],[0,0,1]);
datum_cyl("孔",[22.6701,-1.7857,10],[0,0,1],1.56);
part();
