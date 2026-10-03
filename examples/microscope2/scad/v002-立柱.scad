$fn=64;
// 立柱: Ø22x200 (z=12..212), 根部 Ø40 止口 (z=6..12) + Ø52 法兰 (z=12..18, 4xM3沉头孔 BC Ø46)
// 顶部 3xM3 铜螺母孔 (接弯臂); 两侧 y=±9 防转平面 (z=140..206)
difference(){
  union(){
    translate([0,0,6])   cylinder(d=40,h=6);    // 根部止口
    translate([0,0,12])  cylinder(d=52,h=6);    // 法兰
    translate([0,0,18])  cylinder(d=22,h=194);  // 柱身 -> z=212
  }
  // 防转平面 (y=±9)
  translate([-30,9,140]) cube([60,31,66]);
  translate([-30,-40,140]) cube([60,31,66]);
  // 法兰 4x M3 沉头通孔 (BC Ø46)
  for(a=[45:90:359]) rotate([0,0,a]) {
    translate([23,0,10]) cylinder(d=3.4,h=10);
    translate([23,0,14.5]) cylinder(d=6,h=4);
  }
  // 顶部 3x M3 热熔铜螺母孔 Ø4.2x5.7
  for(p=[[7,0],[-7,0],[0,-7]]) translate([p[0],p[1],206.3]) cylinder(d=4.2,h=6.2);
}
// ---- datum anchors ----
datum("法兰底面",[14,20,12]);
datum("立柱顶面",[0,8,212]);
datum("防转平面",[0,-9,190]);
datum("柱身参考点",[0,-11,100]);
datum_cyl("根部止口",[0,0,9],[0,0,1],20);
datum_cyl("柱身外圆",[0,0,100],[0,0,1],11);
datum_plane("法兰面",[14,20,12],[0,0,1]);
