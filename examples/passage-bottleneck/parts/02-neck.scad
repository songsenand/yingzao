// 02 短颈 —— 沿程只有 2mm 收窄的直孔
//
// 真值：通道瓶颈半径 = 1.25mm（颈的半径）。
//       颈只占通道全长的 1/10（20mm 里的 2mm）——这是"采样密度"的考题：
//       沿轴等距切 N 刀，切到没切到颈，答案就在 1.25 与 4.0 之间跳。
//
// 用途：证明"多刀"（加密站位）才是灵敏度的来源。
$fn = 96;
difference() {
  cube([20, 20, 10], center = true);
  // Ø8 通孔，中间留出 2mm 给颈（cyl 默认不居中，一律显式 center=true）
  translate([0, 10.5, 0]) rotate([-90, 0, 0]) cylinder(r = 4, h = 19, center = true);
  translate([0, -10.5, 0]) rotate([-90, 0, 0]) cylinder(r = 4, h = 19, center = true);
  // 短颈 Ø2.5，长度正好 2mm
  rotate([-90, 0, 0]) cylinder(r = 1.25, h = 2, center = true);
}
