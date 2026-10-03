$fn=64;
// 镜筒: Ø34 外 / Ø26.15 内, z=243..391 (148 长)。
// 座面(下口 z=243) 到像面(z=399, 在目镜筒上) 的名义链: 243 + 156 = 399。
// 外圆 z=248..282 做 34x0.5 外螺纹段, 供精调环旋合 (0.5mm/转)。
P=0.5;
module helix(r0,r1,pitch,len){
  slices=max(24,round(len/pitch*24));
  linear_extrude(height=len, twist=360*len/pitch, slices=slices, convexity=10)
    polygon([[r0,-0.32*pitch],[r1,0],[r0,0.32*pitch]]);
}
difference(){
  union(){
    translate([0,60,243]) cylinder(d=33.4,h=148);        // 筒身 -> z=391
    translate([0,60,248]) helix(16.55,17.0,P,34);       // 34x0.5 外螺纹 z248..282
  }
  translate([0,60,242]) cylinder(d=26.15,h=150);        // 内孔 Ø26.15
}
// ---- datum anchors ----
datum("镜筒下口",[0,60,243]);
datum("镜筒上口",[0,60,391]);
datum("镜筒轴线点",[0,60,300]);
datum_cyl("镜筒内孔",[0,60,300],[0,0,1],13.075);
datum_cyl("镜筒外圆",[0,60,340],[0,0,1],17);
datum_axis("镜筒轴",[0,60,300],[0,0,1]);
