// DN100 PN16 two-piece flanged floating-ball valve — design source.
// Flow axis = X, stem axis = Z (z-up), ball centre = origin. Millimetres.
//
// Construction (see docs/DESIGN-NOTES.md for the why):
//   * one-piece left body (cast WCB) with the pipe flange and the chamber
//   * right end cap (cast WCB) bolted on a Ø236 / 8×M16 mid flange at x=+76
//   * the ball (Ø160, full bore Ø100) enters through the Ø164 chamber opening,
//     the two PTFE seats float in Ø148 pockets, the cap backs the right seat
//   * stem enters from the chamber (Ø44 collar under a Ø44.6 bore = anti-blowout),
//     PTFE packing above it, bolted gland, lever handle with a 90° stop lug
//
// Pipe flange gasket faces are at x=±114.5 -> L=229 mm (EN 558 series 14, DN100).
// Boolean construction overlaps consecutive primitives by OV=0.6 mm so that no
// two faces are exactly coplanar (coplanar CGAL unions leave duplicate seams).
// Every delivered part is ONE connected solid.

$fn = 96;
OV = 0.6;

// ---------------- parameters ----------------
BALL_R      = 80;      // Ø160 full-port ball
BORE_R      = 50;      // Ø100 bore
CH_R        = 82;      // Ø164 chamber
SEAT_OD     = 148;     // PTFE seat OD (Ø148 pockets)
SEAT_ID     = 104;     // seat bore
SEAT_BACK   = 91;      // seat back face |x|
SEAT_OD_X   = 75.1;    // 45° sealing cone meets the seat OD
SEAT_BORE_X = 53.1;    // cone meets the seat bore (0.2 mm off the ball)
JOINT_X     = 76.0;    // body face; cap face at 76.3; PTFE gasket 1.9 thick
CAP_X       = 76.3;
FL_D        = 220;     // pipe flange OD
RF_D        = 158;     // raised face
MF_D        = 236;     // mid flange OD
PCD         = 208;     // 8 × Ø18
HOLE_R      = 9;
NECK_R      = 38;
NECK_TOP    = 170;
PAD_R       = 48;
PAD_BOT     = 155;
BOX_R       = 20;      // Ø40 packing box
BOX_BOT     = 130;
COLLAR_R    = 22;      // Ø44 anti-blowout collar
COLLAR_Z    = 120;
GLAND_TOP   = 182;
PLATE_Z     = 191;
HUB_TOP     = 215;
ARM_LEN     = 400;
STOP_PIN_R  = 52;
STOP_A      = -12;
STOP_B      = 102;

// ---------------- ball ----------------
module ball(ang = 0) {
  rotate([0, 0, ang])
    difference() {
      sphere(r = BALL_R);
      rotate([0, 90, 0]) cylinder(h = 2 * BALL_R + 6, r = BORE_R, center = true);
      // stem slot 24.6 × 14.6, floor at z=68
      translate([0, 0, 68 + 7]) cube([24.6, 14.6, 14], center = true);
    }
}

// ---------------- PTFE seat (right / +x) ----------------
// Turned ring, profile [radius, x]: 45° chamfer from the bore edge (r52, x61.3)
// to the sealing face (r56, x57.3), flat front face to the OD (r74), then the
// 33.7 mm OD land and the flat back face at x=91. 0.2 mm off the ball: the
// PTFE deflects onto the ball under line pressure (modelled, not simulated).
module seat() {
  rotate([0, 90, 0])
    rotate_extrude(convexity = 6)
      polygon(points = [[SEAT_ID / 2, SEAT_BORE_X + 8.2],
                        [SEAT_ID / 2 + 4, SEAT_BORE_X + 4.2],
                        [SEAT_OD / 2 - 0.1, SEAT_BORE_X + 4.2],
                        [SEAT_OD / 2 - 0.1, SEAT_BACK],
                        [SEAT_ID / 2, SEAT_BACK]]);
}

// Same seat with +1 mm on the OD and the back face, used ONLY inside the fluid
// domain so the union with the wall is a solid overlap, never a coincident face.
module seat_fluid() {
  rotate([0, 90, 0])
    rotate_extrude(convexity = 6)
      polygon(points = [[SEAT_ID / 2, SEAT_BORE_X + 8.2],
                        [SEAT_ID / 2 + 4, SEAT_BORE_X + 4.2],
                        [SEAT_OD / 2 + 1, SEAT_BORE_X + 4.2],
                        [SEAT_OD / 2 + 1, SEAT_BACK + 1],
                        [SEAT_ID / 2, SEAT_BACK + 1]]);
}

// ---------------- left body (cast WCB) ----------------
module body() {
  difference() {
    union() {
      // pipe flange + raised face
      translate([-111.5, 0, 0]) rotate([0, 90, 0]) cylinder(h = 17 + OV, r = FL_D / 2);
      translate([-114.5, 0, 0]) rotate([0, 90, 0]) cylinder(h = 3 + OV, r = RF_D / 2);
      // flange boss -> cone -> chamber
      translate([-94.5 - OV, 0, 0]) rotate([0, 90, 0]) cylinder(h = 7.1, r = 85);
      translate([-88.5, 0, 0]) rotate([0, 90, 0]) cylinder(h = 12 + OV, r1 = 85, r2 = 93);
      translate([-76.0 - OV, 0, 0]) rotate([0, 90, 0]) cylinder(h = 136 + OV, r = 93);
      // mid flange
      translate([60.0 - OV, 0, 0]) rotate([0, 90, 0]) cylinder(h = 16 + OV, r = MF_D / 2);
      // stem neck + gland pad
      translate([0, 0, 82]) cylinder(h = NECK_TOP - 82, r = NECK_R);
      translate([0, 0, PAD_BOT]) cylinder(h = NECK_TOP - PAD_BOT, r = PAD_R);
    }
    // bore / pocket / chamber (overlapped so the cut union is clean)
    translate([-116, 0, 0]) rotate([0, 90, 0]) cylinder(h = 21.6, r = BORE_R);
    translate([-95, 0, 0]) rotate([0, 90, 0]) cylinder(h = 20.5, r = SEAT_OD / 2);
    translate([-75.7, 0, 0]) rotate([0, 90, 0]) cylinder(h = 152.6, r = CH_R);
    // PTFE joint gasket groove: 1.6 deep, ID170 / OD182
    translate([74.4, 0, 0]) rotate([0, 90, 0])
      difference() {
        cylinder(h = 2.2, r = 91);      // opens past the joint face (x=76)
        translate([0, 0, -0.1]) cylinder(h = 2.4, r = 85);
      }
    // stem bores: Ø44.6 to z=130, Ø40 packing box above
    translate([0, 0, 80]) cylinder(h = 50.6, r = 22.3);
    translate([0, 0, BOX_BOT - OV]) cylinder(h = NECK_TOP - BOX_BOT + 2 * OV, r = BOX_R);
    // 8 × Ø18 mid-flange bolts (joint flange only)
    for (i = [0:7])
      rotate([0, 0, i * 45 + 22.5])
        translate([PCD / 2, 0, 68]) rotate([90, 0, 0]) cylinder(h = 20, r = HOLE_R, center = true);
    // 4 × M10 gland studs, PCD76, 14 deep in the pad
    for (i = [0:3])
      rotate([0, 0, i * 90 + 45])
        translate([38, 0, 156]) cylinder(h = 15, r = 4.25);
  }
}

// ---------------- right end cap (cast WCB) ----------------
module cap() {
  difference() {
    union() {
      translate([CAP_X, 0, 0]) rotate([0, 90, 0]) cylinder(h = 16 + OV, r = MF_D / 2);
      translate([92.3 - OV, 0, 0]) rotate([0, 90, 0]) cylinder(h = 2.2 + 2 * OV, r = 85);
      translate([94.5, 0, 0]) rotate([0, 90, 0]) cylinder(h = 17 + OV, r = FL_D / 2);
      translate([111.5, 0, 0]) rotate([0, 90, 0]) cylinder(h = 3, r = RF_D / 2);
    }
    // seat pocket, then bore
    translate([CAP_X, 0, 0]) rotate([0, 90, 0]) cylinder(h = SEAT_BACK - CAP_X + OV, r = SEAT_OD / 2);
    translate([SEAT_BACK - OV, 0, 0]) rotate([0, 90, 0]) cylinder(h = 26, r = BORE_R);
    for (i = [0:7])
      rotate([0, 0, i * 45 + 22.5])
        translate([PCD / 2, 0, 84]) rotate([90, 0, 0]) cylinder(h = 19, r = HOLE_R, center = true);
  }
}

// ---------------- stem (die-forged 2Cr13) ----------------
module stem() {
  translate([0, 0, 68 + 6]) cube([24, 14, 12], center = true);   // tang 68..80
  translate([0, 0, 80]) cylinder(h = 40 + OV, r = 14);           // 80..120
  translate([0, 0, COLLAR_Z]) cylinder(h = 10, r = COLLAR_R);    // collar 120..130
  translate([0, 0, 130 - OV]) cylinder(h = 52 + OV, r = 14);     // 130..182
  translate([0, 0, 182]) cube([22, 22, 33]);                     // square 182..215
}

// ---------------- gland (CNC from 2Cr13 bar) ----------------
module gland() {
  difference() {
    union() {
      translate([0, 0, 154]) cylinder(h = NECK_TOP - 154 + OV, r = 19.85);  // Ø39.7 spigot
      translate([0, 0, NECK_TOP]) cylinder(h = GLAND_TOP - NECK_TOP, r = 60);  // stop-plate flange
      for (a = [STOP_A, STOP_B])
        rotate([0, 0, a]) translate([STOP_PIN_R, 0, GLAND_TOP - OV]) cylinder(h = 8 + OV, r = 4);
    }
    translate([0, 0, 148]) cylinder(h = 60, r = 15);                   // Ø30 stem hole
    for (i = [0:3])
      rotate([0, 0, i * 90 + 45]) translate([38, 0, 164]) cylinder(h = 24, r = 5.5);
  }
}

// ---------------- lever handle (die-forged steel) ----------------
module handle() {
  difference() {
    union() {
      translate([0, 0, PLATE_Z]) cylinder(h = 8, r = 55);            // 191..199
      translate([0, 0, 199]) cylinder(h = HUB_TOP - 199, r = 32);
      translate([0, -17, 199]) cube([ARM_LEN, 34, 14]);              // arm 199..213
      translate([47, -5.35, 183]) cube([8, 10.7, 8 + OV]);           // stop lug
    }
    translate([0, 0, PLATE_Z - 1]) cube([22.3, 22.3, HUB_TOP - PLATE_Z + 3]);
  }
}

// ---------------- packing ring / joint gasket (PTFE, CNC) ----------------
module packing() {
  difference() {
    cylinder(h = 6, r = 19.9);
    translate([0, 0, -1]) cylinder(h = 8, r = 14.15);
  }
}

module gasket() {
  // occupies x = 74.4 .. 76.3 (body groove 74.4..76.0, 0.3 mm proud)
  rotate([0, 90, 0])
    difference() {
      translate([0, 0, 74.4]) cylinder(h = 1.9, r = 91);
      translate([0, 0, 74.3]) cylinder(h = 2.1, r = 85);
    }
}

// ---------------- fluid domain ----------------
// The solid the water flows around: the inner cavity surface thickened 8 mm
// outward (the real wall is >= 11 mm), plus the ball at the requested angle and
// both seats. The neck is sealed at z=130 (the packing).
module fluid_wall() {
  // One continuous shell: a Ø180 tube around the whole flow path, minus the
  // inner cavity. The 8 mm wall stays inside the real 11 mm body wall, and the
  // single outer cylinder guarantees one connected solid across the joint.
  difference() {
    union() {
      translate([-114.5, 0, 0]) rotate([0, 90, 0]) cylinder(h = 228.9, r = 90);
      translate([0, 0, 80]) cylinder(h = 54, r = 30.3);
    }
    translate([-116, 0, 0]) rotate([0, 90, 0]) cylinder(h = 21.6, r = BORE_R);
    translate([-95, 0, 0]) rotate([0, 90, 0]) cylinder(h = 20.4, r = SEAT_OD / 2);
    translate([-75.6, 0, 0]) rotate([0, 90, 0]) cylinder(h = 152.5, r = CH_R);
    translate([CAP_X, 0, 0]) rotate([0, 90, 0]) cylinder(h = SEAT_BACK - CAP_X + OV, r = SEAT_OD / 2);
    translate([SEAT_BACK, 0, 0]) rotate([0, 90, 0]) cylinder(h = 25, r = BORE_R);
    translate([0, 0, 80]) cylinder(h = 50, r = 22.3);
  }
  translate([0, 0, 129.4]) cylinder(h = 4.6, r = 22.3);   // seal above the packing
}

module fluid(ang = 0) {
  union() {
    fluid_wall();
    ball(ang);
    seat_fluid();
    mirror([1, 0, 0]) seat_fluid();
  }
}

// ---------------- part switch ----------------
PART = "body";
if (PART == "body")         body();
if (PART == "cap")          cap();
if (PART == "ball")         ball(0);
if (PART == "seat")         seat();
if (PART == "stem")         stem();
if (PART == "gland")        gland();
if (PART == "handle")       handle();
if (PART == "packing")      packing();
if (PART == "gasket")       gasket();
if (PART == "fluid-open")   fluid(0);
if (PART == "fluid-45")     fluid(45);
if (PART == "fluid-closed") fluid(90);
