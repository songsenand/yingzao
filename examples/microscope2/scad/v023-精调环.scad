$fn=64;
// 精调环 v2: 滚花凸台收到 z=252..278 —— 原来做到 279, 顶进滑座抱筒环 54mm³。
// Ø40 环, 内孔 Ø34.4 带 34x0.5 内螺纹槽, 高 26。顶面顶住滑座抱筒孔底面 (z=278)。
P=0.5;
module helix(r0,r1,pitch,len){
  slices=max(24,round(len/pitch*24));
  linear_extrude(height=len, twist=360*len/pitch, slices=slices, convexity=10)
    polygon([[r0,-0.32*pitch],[r1,0],[r0,0.32*pitch]]);
}
difference(){
  union(){
    translate([0,60,252]) cylinder(d=40,h=26);
    for(a=[0:15:359]) translate([19*cos(a),60+19*sin(a),252]) cylinder(d=2.2,h=26);
  }
  for(a=[0:15:359]) translate([19*cos(a),60+19*sin(a),251]) cylinder(d=1.4,h=28);
  translate([0,60,250]) cylinder(d=34.4,h=30);
  translate([0,60,251.5]) helix(16.9,17.7,P,27);
}
// ---- datum anchors ----
datum("精调环轴心",[0,60,265]);
datum("精调环顶面",[0,60,278]);
datum("精调环底面",[0,60,252]);
datum_cyl("精调环内孔",[0,60,265],[0,0,1],17.2);
