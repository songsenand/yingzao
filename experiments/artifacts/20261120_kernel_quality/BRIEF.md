# Same-prompt brief (L1.11 kernel-quality comparison)

Design a **single, closed, manifold, 3D-printable mounting plate**.

- Overall envelope: **60 mm (X) × 40 mm (Y) × 6 mm (Z)**, Z up, units mm.
- **Bottom face at Z=0**; datums are in final world coordinates.
- Four **Ø4.5 mm through-holes**, axes parallel to Z:
  - centres at **x = ±22 mm, y = ±13 mm**.
  - holes must go fully through the 6 mm plate.
- All four **vertical (Z-parallel) outer corners** have an **R4 mm fillet**.
- One connected solid; no separate bodies, no open surfaces, no non-manifold edges.
- Declare these datums in final world coordinates:
  - point `top` at (0, 0, 6)
  - plane `top_plane` at (0, 0, 6), normal (0, 0, 1)
  - axis `hole_axis` at (22, 13, 0), direction (0, 0, 1)
  - cylinder `hole` at (22, 13, 0), direction (0, 0, 1), radius 2.25
- For OpenSCAD use `$fn=64`; for CadQuery use the normal Workplane/box API.
- Do not add cosmetic features. The part must fit the envelope exactly.

Deliver one version per kernel; render top+iso; report mesh truth, dimensions, volume,
surface area, datums, and validation issues.
