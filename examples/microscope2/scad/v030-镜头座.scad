$fn=64;
// 镜头座: Ø40 法兰 (z=235..243, 顶面 = 镜头座安装面) + Ø26 止口 (z=243..259, 插进镜筒)。
// 中心 M12x0.5 内螺纹口装 f=12 M12 板机镜头。镜头座高度 = 8.0 (243-235)。
P=0.5;
module helix(r0,r1,pitch,len){
  slices=max(24,round(len/pitch*24));
  linear_extrude(height=len, twist=360*len/pitch, slices=slices, convexity=10)
    polygon([[r0,-0.32*pitch],[r1,0],[r0,0.32*pitch]]);
}
difference(){
  union(){
    translate([0,60,235]) cylinder(d=40,h=8);      // 法兰
    translate([0,60,243]) cylinder(d=26,h=16);     // 止口 (插镜筒 Ø26.15)
  }
  translate([0,60,234]) cylinder(d=11.0,h=11);     // M12 螺纹底孔 Ø11.0
  translate([0,60,234]) helix(5.4,6.25,P,10);      // M12x0.5 内螺纹牙
}
// ---- datum anchors ----
datum("镜头座安装面",[0,60,243]);
datum("镜头座轴心",[0,60,230]);
datum("镜头座底端",[0,60,235]);
datum_cyl("镜头座止口",[0,60,250],[0,0,1],13);
datum_cyl("镜头座螺纹",[0,60,238],[0,0,1],6);
datum_axis("镜头座轴",[0,60,240],[0,0,1]);
