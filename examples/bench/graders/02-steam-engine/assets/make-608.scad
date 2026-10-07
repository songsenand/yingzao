// 608 bearing — schematic solid for the 02-steam-engine `import_part` lane.
//
// This is NOT a functional bearing, and it is not trying to be. A real 608 is
// three disconnected bodies (outer race, inner race, balls); `import_part` runs
// Manifold and `check_connectivity` enforces "a part is ONE connected solid", so
// a faithful model would be correctly REJECTED. What the import lane needs is a
// dimensionally-correct, single-connected bought part to design around:
// import it, declare its unit (STL carries none), declare datums on it (an STL
// carries none), and use it as an interface endpoint.
//
// So: one solid with the real 608 envelope (OD 22, bore 8, width 7), with two
// shallow annular grooves marking where the races would be. The grooves are
// cosmetic — they keep the silhouette readable in a render without ever
// disconnecting the body.
//
// Generate once, before a benchmark run:
//
//   cd examples/bench/02-steam-engine/assets
//   OPENSCADPATH=<repo>/lib openscad -o 608.stl make-608.scad
//
// The generated 608.stl is a build artifact and is NOT committed. Before using
// it, confirm it is one body by importing it — `import_part` refuses a mesh that
// is not a closed solid, which is the guard, not an obstacle.

$fn = 48;

od = 22;      // outer diameter
bore = 8;     // bore
width = 7;    // race width
groove_d = 17;    // race groove diameter (visual only)
groove_w = 0.8;   // groove depth

difference() {
  cylinder(d = od, h = width, center = true);

  // bore
  cylinder(d = bore, h = width + 2, center = true);

  // cosmetic race grooves on both faces — shallow, never through-thickness
  for (z = [-1, 1])
    translate([0, 0, z * (width / 2)])
      rotate_extrude()
        translate([groove_d / 2, 0])
          circle(r = groove_w, $fn = 16);
}
