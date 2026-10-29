$fn = 64;
// L-bracket: base 80x40x10, wall 10x40x80 on top at x=0..10.
// Right-angle reentrant corner at (x=10, z=10); bottom is the ground contact face.
union() {
  cube([80, 40, 10]);
  translate([0, 0, 10]) cube([10, 40, 80]);
}
