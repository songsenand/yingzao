// 发条盒（鼓）：外购发条装在里面，口部卡簧槽
$fn = 64;
A = [4, 0];
module part() {
  difference() {
    translate([A[0],A[1],7.2]) cylinder(h=5.6, d=20.0);
    // 内腔
    translate([A[0],A[1],8.2]) cylinder(h=5.0, d=17.0);
    // 轴孔
    translate([A[0],A[1],7.0]) cylinder(h=1.5, d=5.12);
    // 卡簧槽
    translate([A[0],A[1],11.3]) difference() {
      cylinder(h=0.9, d=17.6); cylinder(h=0.9, d=16.2);
    }
    // 发条外端卡槽
    translate([A[0],A[1],0]) rotate([0,0,30]) translate([8.0,-0.55,8.4]) cube([2.5,1.1,2.0]);
  }
}
datum_axis("轴A",[4,0,10],[0,0,1]);
datum_cyl("轴孔",[4,0,7.5],[0,0,1],2.56);
datum_plane("底面",[4,0,7.2],[0,0,-1]);
datum_plane("口面",[4,0,12.8],[0,0,1]);
part();
