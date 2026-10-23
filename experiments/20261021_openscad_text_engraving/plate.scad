// Flat-face text: engraved (left) and embossed (right).
// Render:  openscad --backend=Manifold -o plate.stl plate.scad
$fn   = 96;
FONT  = "Noto Sans CJK SC:style=Bold";
SIZE  = 6.5;
DEPTH = 0.8;
TXT   = "造物 ToyMarker";

module glyphs(h)
    linear_extrude(height = h)
        text(TXT, size = SIZE, font = FONT, halign = "center", valign = "center");

translate([-42, 0, 0]) difference() {                 // engraved: subtract
    cube([76, 28, 5], center = true);
    translate([0, 0, 2.5 - DEPTH]) glyphs(DEPTH + 0.01);
}

translate([42, 0, 0]) union() {                       // embossed: add
    cube([76, 28, 5], center = true);
    translate([0, 0, 2.5 - 0.01]) glyphs(DEPTH + 0.01);
}
