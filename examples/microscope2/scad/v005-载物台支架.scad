$fn=64;
// 载物台支架: 背面贴弯臂前立面 (y=14), 顶面 z=222.13 托载物台底面.
// 它把"载物台↔弯臂"的 1.0mm 让位间隙留在清单之外 (故意的未声明邻近对).
module bracket(){
  difference(){
    union(){
      translate([-42,14,200]) cube([84,26,22.13]);              // 主体
      translate([-42,14,196]) cube([84,10,4]);                  // 后下加强
    }
  }
}
difference(){
  bracket();
  for(sx=[-1,1]) translate([sx*15,13.5,217]) rotate([-90,0,0]) cylinder(d=3.4,h=8);  // 与弯臂 M3 通孔
  for(sx=[-1,1]) translate([sx*30,30,222.13-5.7]) cylinder(d=4.2,h=6.8);             // 载物台铜螺母孔
}
// ---- datum anchors ----
datum("支架顶面",[0,30,222.13]);
datum("支架背面",[0,14,217]);
datum_plane("托面",[0,30,222.13],[0,0,1]);
