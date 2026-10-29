$fn = 64;
// Block 80x40x40, V-notch cut from the bottom contact face.
// V root at (x=40, z=30), void angle ~37 deg; two bottom feet at z=0.
difference() {
  cube([80, 40, 40]);
  translate([0, 42, 0])
    rotate([90, 0, 0])
      linear_extrude(height = 42)
        polygon(points = [[30, 0], [50, 0], [40, 30]]);
}
