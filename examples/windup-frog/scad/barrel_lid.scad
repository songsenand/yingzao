// 发条盒盖 + 30T 齿轮 (barrel lid with 30T gear)
include <BOSL2/std.scad>
include <BOSL2/gears.scad>
$fn = 64;

AX = 4; AY = 0;
module part() {
  difference() {
   union() {
    translate([AX, AY, 14.2])
      spur_gear(mod=0.7, teeth=30, thickness=2.6, shaft_diam=0, backlash=0.06);
    // 压入盒口的定位凸台 + 卡簧唇边
    translate([AX, AY, 11.3]) cylinder(h=1.6, d=16.6);
    translate([AX, AY, 11.4]) cylinder(h=0.75, d=17.4);
   }
   translate([AX, AY, 10.0]) cylinder(h=7.0, d=5.12);
  }
}
datum_axis("轴A",[4,0,13],[0,0,1]);
datum_cyl("孔",[4,0,14],[0,0,1],2.56);
datum_plane("配合面",[4,0,12.9],[0,0,-1]);
part();
