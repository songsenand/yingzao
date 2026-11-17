# ball-valve-dn100 — process profiles (draft)

| file | profile id | used for |
|---|---|---|
| [sand-cast-wcb.json](sand-cast-wcb.json) | `sand-casting-wcb` | WCB body **as cast**: draft, wall, cored holes |
| [cnc-3axis-cast-steel.json](cnc-3axis-cast-steel.json) | `cnc-3axis-cast-steel` | same body **after casting**: machined walls, bores, faces |
| [die-forge-2cr13.json](die-forge-2cr13.json) | `die-forge-2cr13` | 2Cr13 ball and stem blanks, closed-die hot forging |
| [cnc-sheet-ptfe-1.9.json](cnc-sheet-ptfe-1.9.json) | `cnc-sheet-ptfe-1.9` | 1.9 mm PTFE gasket, 2.5D profiling (sheet thickness is not a "wall") |

Every number is a draft assumption (`rule-of-thumb`), to be calibrated on the chosen shop;
none is a certificate — `not-excluded` means no counter-example was found, not "can be made".
`profilesJson` takes a JSON **array** (one profile per element); `profileIds` only resolves
profiles shipped in `dsh-cad-harness/schemas/examples/`, so pass these inline.

Which ruler on which artifact: the delivered CAD is the **machined** part, so it is screened
with the CNC / turning / sheet profiles; the sand-cast and die-forge profiles describe the
**pattern and die**, which are not in the CAD (draft, fillets, machining allowance are the
mould shop's job). Screening the machined solid against `draftMinDeg` would report a witness on
every machined wall — the wrong ruler, not a design failure.

Closest to the margin (measured 2026-11-17): `wallMinMm` on the **ball bore mouth** (0.026 mm,
a sharp edge → chamfer 0.5×45°); then the step corner on the body/cap (0.15/0.47 mm, also
edges). `draftMinDeg` was not measured on this CAD — see the paragraph above.
