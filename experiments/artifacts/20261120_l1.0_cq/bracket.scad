$fn = 64;
difference() {
  linear_extrude(height = 6)
    offset(r = 4)
      offset(r = -4)
        square([60, 40], center = true);
  for (x = [-22, 22])
    for (y = [-13, 13])
      translate([x, y, -1])
        cylinder(h = 8, d = 4.5);
}
