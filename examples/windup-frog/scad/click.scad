// 棘爪：转轴 + 导向长孔（止挡）+ 0.8 厚簧片
$fn = 64;
P = [13.5, -6.5];
T = [8.949, -5.899];
Z0 = 22.7; H = 1.2;

module shape2d() {
  union() {
    translate(P) circle(r=3.5);
    hull() { translate(P) circle(r=1.7); translate(T) circle(r=0.7); }
    // 止挡页（长孔套在 G 柱上）
    translate([15.5,-9.8]) square([5.8,9.6]);
    // 簧片 0.8 宽
    for (i=[0:5])
      hull() {
        translate([20.9 + (24.4-20.9)*i/5, -6.5 + (-7.0+6.5)*i/5]) circle(r=0.4);
        translate([20.9 + (24.4-20.9)*(i+1)/5, -6.5 + (-7.0+6.5)*(i+1)/5]) circle(r=0.4);
      }
  }
}
module part() {
  difference() {
    translate([0,0,Z0]) linear_extrude(H) shape2d();
    translate([P[0],P[1],Z0-1]) cylinder(h=H+2, d=4.3);
    // 导向长孔：负载侧紧（-y），上弦侧留 3mm
    translate([17.3,-8.7,Z0-1]) cube([3.4,7.2,H+2]);
  }
}
datum_axis("轴P",[13.5,-6.5,23.3],[0,0,1]);
datum_cyl("孔P",[13.5,-6.5,23.3],[0,0,1],2.15);
part();
