// 凸轮从动滑块：板 + 两只 φ4 输出销（穿底板长孔，向下伸到腿连杆）
$fn = 64;
module part() {
  union() {
    translate([0,0,3]) linear_extrude(3) translate([11.7,0]) hull() {
      for (p=[[-2.9,5.6],[2.9,5.6],[-2.9,-5.6],[2.9,-5.6]]) translate(p) circle(r=0.8);
    }
    for (s=[-1,1]) translate([11.5, s*3.2, -2.0]) cylinder(h=5.2, d=4.0);
  }
}
datum_plane("凸轮面",[8,0,4.5],[-1,0,0]);
datum_plane("导向面",[12,6.4,4.5],[0,1,0]);
datum_axis("销1",[11.5,3.2,2.0],[0,0,1]);
datum_axis("销2",[11.5,-3.2,2.0],[0,0,1]);
part();
