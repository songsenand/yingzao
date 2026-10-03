$fn=64;
// 粗调旋钮 v2: 随齿轮轴外移到 (y=26.5, z=265)。Ø30x8, 双 D 孔, OD 滚花。
YC=26.5;
difference(){
  union(){
    translate([34,YC,265]) rotate([0,90,0]) cylinder(d=30,h=8);
    for(a=[0:15:359]) translate([33,YC+15*cos(a),265+15*sin(a)]) rotate([0,90,0]) cylinder(d=2.2,h=10);
  }
  for(a=[0:15:359]) translate([33,YC+15*cos(a),265+15*sin(a)]) rotate([0,90,0]) cylinder(d=1.4,h=10);
  translate([33,YC,265]) rotate([0,90,0]) cylinder(d=8.2,h=10);
  translate([33,YC-3.3-5,260]) cube([10,5,10]);
  translate([33,YC+3.3,260])    cube([10,5,10]);
}
// ---- datum anchors ----
datum("旋钮轴心",[38,YC,265]);
datum_cyl("旋钮孔",[38,YC,265],[1,0,0],4.1);
datum("旋钮外端面",[42,YC,265]);
