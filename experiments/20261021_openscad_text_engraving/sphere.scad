// Engraving on a curved surface (sphere): cut with a flat-bottom prism that
// pokes through the surface. Depth is exact at the text centre and gets
// shallower towards the edges; the glyph is only cut where the prism still
// reaches the surface, i.e. within |x| < sqrt(2*R*DEPTH - DEPTH^2).
// For R=60, DEPTH=1.0 that is +/-10.9 mm half-width (~22 mm of text run).
// Wider text gets truncated at the ends (the letters look cut/flipped, which
// is easy to misread as a mirroring bug) -> use a bigger radius and/or a
// smaller DEPTH, or wrap around a cylinder (cylinder.scad).
//
// A "constant depth" alternative is  difference(sphere, intersection(shell, glyph)).
// It follows the curvature further, but in this test it produced 13
// non-manifold edges while the prism below produced 0.
//
// Render:  openscad --backend=Manifold -o sphere.stl sphere.scad
$fn   = 160;
FONT  = "Noto Sans CJK SC:style=Bold";
R     = 60;
DEPTH = 1.0;
SIZE  = 8;
TXT   = "TOY";

difference() {
    sphere(r = R);
    // text lies in XY (upright) and extrudes +Z through the north pole
    translate([0, 0, R - DEPTH])
        linear_extrude(height = DEPTH + 2)
            text(TXT, size = SIZE, font = FONT, halign = "center", valign = "center");
}
