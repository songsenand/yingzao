// 旋梭轴组 hook_arbor — 旋梭本体 + 轴 + 曲柄，整体一件（304 不锈钢，CNC 车+铣）
// 轴沿 +Y，旋梭中心在原点；z 向上。mm。
// 旋梭外径 Ø45（1.5× 家用 15 类）；前端沉孔 Ø37.6 容纳梭壳法兰 Ø36.6。
// 齿轮座：y -70..-60，D 形扁位 x>3.5；卡簧槽 y -71.5..-70.4（DIN471 Ø10）。
$fn = 96;

module cylY(y0, y1, r) {
  translate([0, y1, 0]) rotate([90, 0, 0]) cylinder(h = y1 - y0, r = r);
}

module sector_ring(r0, r1, a0, a1, h, y0) {
  translate([0, y0, 0]) rotate([90, 0, 0])
    linear_extrude(height = h)
      polygon(concat(
        [for (a = [a0:1.5:a1]) [r1*cos(a), r1*sin(a)]],
        [for (a = [a1:-1.5:a0]) [r0*cos(a), r0*sin(a)]]
      ));
}

PX = 12 * cos(311);
PZ = 12 * sin(311);

difference() {
  union() {
    cylY(-8, 8, 22.5);                              // 旋梭本体 Ø45×16
    sector_ring(19, 22.5, 72, 96, 4.5, -8);        // 钩尖/喙，向后伸到 y=-12.5
    cylY(-72, -8, 5);                               // 轴 Ø10
    cylY(-60, -58.4, 6);                            // 齿轮前定位台肩 Ø12
    cylY(-46, -42, 6);                              // 轴承内圈隔套 Ø12
    cylY(-34, -31, 6);                              // 前轴承前侧台肩 Ø12
    hull() {                                        // 曲柄臂 y -32..-28
      cylY(-32, -28, 7);
      translate([PX, 0, PZ]) cylY(-32, -28, 6);
    }
  }
  cylY(2, 8.5, 18.8);                               // 梭壳沉孔 Ø37.6
  sector_ring(17, 24, 96, 112, 24, -14);            // 梭道装入口
  translate([PX, 0, PZ]) cylY(-38, -27, 3);         // 曲柄销孔 Ø6（贯穿臂+前伸）
  translate([3.5, -70, -30]) cube([10, 10, 60]);    // 齿轮轴颈 D 扁位
  cylY(-71.5, -70.4, 4.3);                          // 卡簧槽 Ø8.6
}

datum("hook-center", [0, 0, 0]);
datum_axis("hook-axis", [0, -40, 0], [0, 1, 0]);
datum_plane("hook-face", [0, 8, 0], [0, 1, 0]);
datum_axis("crank-pin-axis", [PX, -33, PZ], [0, 1, 0]);
datum_axis("gear-seat-axis", [0, -65, 0], [0, 1, 0]);
datum_plane("gear-seat-face", [0, -60, 0], [0, 1, 0]);
datum_axis("bearing-rear", [0, -50, 0], [0, 1, 0]);
datum_axis("bearing-front", [0, -38, 0], [0, 1, 0]);
datum("hook-tip", [22.5 * cos(96), -10, 22.5 * sin(96)]);
