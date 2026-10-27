---
name: cad-manufacturing
description: "Manufacturability: the printability screen, the wallMeasured gate, and process profiles (a threshold is a declared claim; the tool excludes with a witness, never ranks). Full checklist and profile-authoring norms: docs/llm/manufacturing.md."
whenToUse: "Before delivering a printable part, whenever a wall / threshold / tolerance question comes up, or when a design was changed to satisfy a manufacturing rule."
---

# Manufacturability: the short rules

Router: `skills/cad-toolbox/SKILL.md` — this file assumes you loaded it.

A screen answers "does this violate a declared rule". It never answers "which process should I use" — that is a business decision.

## Checklist (volunteer it with the design)

- **Overhangs**: holes/racks/threads along Z print support-free; a horizontal ceiling is a bridge — keep spans ≤30mm and say so.
- **Layer direction**: columns/tubes print standing; a spring must print with layers perpendicular to the bending neutral face.
- **Threads**: no fine load-bearing printed threads; use a clearance hole + locknut/insert. Coarse (≥1.5mm pitch) is fine.
- **Fits**: printed mating pairs ±0.15mm loose; "tight" means a fastener/insert, not a tight print.
- **Bed/time**: check bbox against the bed and the time budget; a part that does not fit is split, and the joint becomes an interface.
- **Color is not a geometric pass.** `attach_appearance` stores a GLB sidecar; the panel still previews STL.

## Rules

- **Declare the process** via `profileIds` (e.g. `["fdm-pla-0.4"]`) or `profilesJson`. No profile → built-in fallback, every number `assumed`, and a pass is downgraded.
- **Two verdicts, neither is "ok"**: `excluded` (with a witness: rule, location, measured vs required) or `not-excluded`. **`not-excluded` ≠ can be made.**
- **A missing number is not "no constraint".** Undeclared rules come back in `unevaluable`; not-applicable rules are named, not silently dropped.
- **Never rank or recommend.** Give each profile's verdict and margins; the user decides.
- **The wall half is sampled; `wallMeasured: false` means the ray half measured nothing — never a pass.** Overhang area is exact.
- **A sealed cavity is the only escape-passage failure a mesh can prove.** A passage that merely narrows is not claimed.
- **CNC tool reach is exact only for circular bores.** Non-circular slots/pockets are not covered, and the report says so.
- **`judge` / `scan` / `both`**: `scan` returns the field and **no verdict**; `judge` returns `nextLook` (where to look) — the field is not a gate.

Full checklist, profile-authoring norms (direction, trust ladder, calibration coupons), and the sealed-cavity/tool-reach reasoning: `docs/llm/manufacturing.md`.
