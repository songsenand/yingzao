# SCAD sources

These are the **same sources** that produced the delivered versions. The datum
versions `v061`–`v085` are mesh copies created by `set_datums`; OpenSCAD sources
live with the pre-datum versions, so this folder maps them:

| file | version in the corpus | note |
|---|---|---|
| `barrel_front.scad` | v048 → datum copy v061 | two Ø2.4 nose holes at x=±1.6 |
| `barrel_rear.scad` | v050 → v062 | z=85..128, boss at +Y z=119 |
| `rotor.scad` | v081 → v085 | stacked tracks 6.3/3.6, both rings 1.6 mm, ratchet collar 7.6 |
| `rotor_retainer.scad` | v051 → v064 | 7.25..7.70 ring + 3 snaps |
| `cap_ring.scad` | v079 → v083 | z=122..128, body/flange 0.4 mm |
| `button.scad` | v082 → v084 | 4 mm travel, 3 pawls, skirt 0.4 mm, Ø19.9 |
| `clip.scad` | v059 → v071 | collar 110..112, strip to 120 |
| `refill.scad` | v045 → v067 | stock Ø2.4×100 |
| `carrier_black.scad` | v046 → v068 | outer arm to r=6.3 |
| `carrier_red.scad` | v047 → v069 | inner post + pusher |
| `leaf_spring.scad` | v057 → v070 | 0.8 mm PP leaf |
| `spring_button.scad` | v058 → v072 | stock spring, installed 28 |
| `detent_plunger.scad` | v030 → v073 | stock M3 ball plunger |

To regenerate, open the file in OpenSCAD (or pass its text to `generate_part`);
the assembly references the datum copies, not these files. Do not edit the
`cad-data/versions/*/model.scad` copies — they are the corpus record.
