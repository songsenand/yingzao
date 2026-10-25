// Decorative wall panel — a render target for the optional Blender/bpy art lane.
// 240 x 160 x 14 mm, one solid, no supports assumed. Pure OpenSCAD: the geometry
// stays in the authoritative (parametric) source; Blender only lights and shoots it.
$fn = 64;

W = 240;
H = 160;
T = 10;        // base thickness
RIM = 12;      // raised border width
RIM_H = 4;     // raised border height
R = 12;        // corner radius

module rounded_plate(w, h, t, r) {
    hull()
        for (x = [r, w - r], y = [r, h - r])
            translate([x, y, 0]) cylinder(r = r, h = t);
}

module hex_pattern() {
    for (x = [36 : 28 : W - 36])
        for (y = [34 : 24 : H - 34])
            translate([x, y, -1]) cylinder(r = 9.5, h = T + 2, $fn = 6);
}

module mounting_holes() {
    for (x = [20, W - 20])
        for (y = [20, H - 20])
            translate([x, y, -1]) cylinder(r = 3.2, h = T + RIM_H + 2);
}

difference() {
    union() {
        rounded_plate(W, H, T, R);
        // raised border: outer ring minus its inner opening
        difference() {
            rounded_plate(W, H, T + RIM_H, R);
            translate([RIM, RIM, -1])
                rounded_plate(W - 2 * RIM, H - 2 * RIM, T + RIM_H + 2, R - 4);
        }
    }
    hex_pattern();
    mounting_holes();
    // small central recess so the light has something to read
    translate([W / 2, H / 2, T - 2])
        cylinder(r = 26, h = 6, $fn = 96);
}
