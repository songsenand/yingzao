# ball-valve-dn100 — process profiles (draft)

| file | profile id | used for |
|---|---|---|
| [sand-cast-wcb.json](sand-cast-wcb.json) | `sand-casting-wcb` | WCB body **as cast**: draft, wall, cored holes |
| [cnc-3axis-cast-steel.json](cnc-3axis-cast-steel.json) | `cnc-3axis-cast-steel` | same body **after casting**: machined walls, bores, faces |
| [die-forge-2cr13.json](die-forge-2cr13.json) | `die-forge-2cr13` | 2Cr13 ball and stem blanks, closed-die hot forging |

Every number is a draft assumption (`rule-of-thumb`), to be calibrated on the chosen shop;
none is a certificate — `not-excluded` means no counter-example was found, not "can be made".
`profilesJson` takes a JSON **array** (one profile per element); `profileIds` only resolves
profiles shipped in `dsh-cad-harness/schemas/examples/`, so pass these three inline.

Closest to the margin (expected, not yet measured): `draftMinDeg` 2 deg on the as-cast body —
CAD bodies are usually drawn with 0 deg draft, so it decides first; runner-up `wallMinMm` 6 mm.
