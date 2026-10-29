# 制造性：筛查、工艺档案与校准

> 长解释参考；短规则在 `skills/cad-manufacturing/SKILL.md`。

A manufacturing screen answers "does this violate a declared rule". It never answers "which process should I use" — that is a business decision, not a check result.

> **Terminology (2026-10-29).** In this document "overhang" always means **print-overhang**: an FDM surface that is not self-supporting, a support/printability question. It is **not** structural overhang / self-weight stress (internal stress under gravity), which belongs to `simulate_stress`'s **strength** question. That load case now exists (`includeSelfWeight` defaults true; `supports:[{ground:true}]` holds the lowest z face), but it is not physically validated. Do not use unqualified "overhang" for the strength layer.

## Printability checklist (volunteer it with the design, don't wait to be asked)

- **Overhangs (print-overhang)**: holes, racks, threaded cavities with the axis along Z print
  support-free; a horizontal closed ceiling is a bridge — keep spans ≤30mm and
  say so when one is longer.
- **Layer direction**: stiff parts (columns, tubes) print standing; a spring
  (cantilever clip) must print with layer lines perpendicular to the bending
  neutral face, or it snaps along a layer.
- **Threads**: never print fine load-bearing threads (M12×0.5 and tighter) —
  use a clearance hole + locknut or a heat-set insert. Coarse printed threads
  (≥1.5mm pitch) are fine; trapezoidal/square profiles print support-free.
- **Fits**: printed mating pairs get ±0.15mm loose fit; "tight" means a fastener
  or an insert, not a tight print.
- **Bed and time**: check each part against the bed (e.g. 220×220×250) and the
  time budget (e.g. ≤6h) with `measure_part`'s bbox; a part that does not fit is
  split — and the new joint goes into the assembly manifest as an interface.
- **Color is design data, not a geometric pass.** `check_printability` does not
  check color; a colored render is not a print-color promise. A GLB can be stored
  as an appearance sidecar with `attach_appearance`, but it is not a print-color
  workflow and the panel still previews STL.

## Process profiles: a threshold is a declared claim, not a literal

The screen used to hold its thresholds as literals (`wallMinMm` 1.2, `overhangDeg` 45).
A literal is a claim with no author: nobody can challenge it, and it silently shapes the
design, because a part converges on *whatever passes the default*. That is how a
propeller's trailing edge gets thickened to satisfy a rule belonging to a process nobody
chose.

So a threshold is now a **profile**: a small JSON document (schema:
`dsh-cad-harness/schemas/process-profile.schema.json`, examples in
`schemas/examples/`) naming the process, the material and — for every rule — whether it
applies at all, whether a tool can decide it from the mesh, and **where the number came
from** (`vendor-spec` / `standard` / `measured` / `literature` / `rule-of-thumb` /
`assumed`). Declare one with `profileIds: ["fdm-pla-0.4"]` or inline via `profilesJson`.

Four rules that are not negotiable, and each is enforced in code rather than promised:

1. **Two values, and neither of them is "ok".** A profile yields `excluded` (with a
   witness: rule + location + measured vs required) or `not-excluded`. **`not-excluded`
   means no geometric counter-example was found — it is NOT "this can be made".**
2. **Never a ranking.** The tool does not score, rank or recommend a process, and the
   profile schema refuses a `recommendedProcess`-style field. Cost, yield, lead time and
   achievable tolerance are not geometric facts; inventing them is how a tool starts
   making business decisions. Ask for the comparison, then decide yourself.
3. **Not applicable is said out loud.** Powder-bed and machining have no print-overhang
   constraint; only molding has draft. Reporting an SLS part's print-overhang as "needs
   support" is not conservative, it is *wrong*. Every rule carries `applies` + a reason,
   and the report lists them.
4. **A missing number is not "no constraint".** Rules the profile never declares come
   back in `unevaluable` — along with the capability rules (tolerance, surface finish)
   that no mesh can decide.

**No profile declared is not a pass.** The screen then uses a built-in FDM/PLA fallback
whose every number is marked `assumed` (it reproduces exactly those old literals), names
it in `profileSource` and the findings with its hash, and **downgrades `ok` to `check`**.
Declaring a profile is what earns a pass — and the profile id + content hash travel with
the verdict, because a verdict without its premise is not evidence.

## Sealed cavities: the one escape-passage failure a mesh can prove

For powder-bed (SLS/MJF) and resin (SLA/DLP) profiles, `escapePassageMinMm` says how wide
a passage must be for trapped powder or uncured resin to leave. The screen can **prove**
one failure: a **sealed cavity** — a hollow with no opening at all — where the passage
size is therefore zero. It finds them by the **sign of each shell's volume**: a cavity's
outward normal (outward from the *material*) points into the void, so its signed volume
is negative while a separate body's is positive. That sign is also the only thing that
separates "trapped powder" from "two floating fragments" — both show up as shells > 1,
and `bodies` alone cannot tell them apart.

**The other half is deliberately not claimed.** A passage that merely *narrows* inside
cannot be proved from the surface, because the tunnel's interior cross-section is not
measured. Every time an escape rule applies and no sealed cavity is found, the report
says so in a finding. So `not-excluded` here means "no **sealed** cavity" — never "the
drain works". Narrow-passage exclusion is a real gap, and it is stated rather than
papered over.

## Tool reach (CNC): exact for bores, disclosed for everything else

For a machining profile, `toolRadiusMm` is the smallest cutter the shop will use and
`holeAspectMax` caps how deep a hole may be relative to its diameter. Both are evaluated
against the **circular bores** the feature inventory already finds — exact numbers
(diameter, length), not estimates: a cutter of radius *r* cannot enter a bore narrower
than *2r*, and a hole deeper than *N* diameters wanders. The witness is stated in the
same units as the rule (a 0.75mm bore radius against a 1.5mm cutter) and located at the
bore's centre.

**What is not covered is said out loud.** A non-circular slot or a narrow pocket needs a
voxel reachability sweep, which this screen does not do. Whenever a profile declares
`toolRadiusMm`, the report carries a finding saying so — because "not excluded" there
means "no *bore* was too narrow", never "this can be machined". (The note appears only
where the cutter rule is actually declared: a profile that merely caps hole aspect — FDM
does, a deep narrow hole is a printing problem too — is making no claim about cutters,
and `findings` must stay about the geometry.)

## Authoring a profile: where the numbers come from, and who signs them

The screen judges geometry **against a profile**, so a profile is where the knowledge
lives — and writing one is a skill. It is not a tool: a tool would have to invent the
numbers, and inventing them is the one thing this whole design refuses to do (a bundled
material table cannot be self-verified, decays, and stale-but-authoritative is worse than
absent — DECISION-LOG 2026-10-11). So the work is yours, and these are the norms.

**1a. A rule also declares its DIRECTION, and the tool obeys it.** `applies: true`
needs `value` + `direction` + `source`; a profile missing any of them is refused with
the rule named. `direction: 'min'` means the value is a LOWER bound (violating =
measured below it — walls, cutter radius, clearance); `'max'` means an UPPER bound
(violating = measured above it — overhang angle, hole aspect). The comparison is one
function (`violatesRule`), so a declared `max` is not silently read as a minimum.
Adjacent to this: the *gray band* of a measurement is not a second declared number —
it comes from the measurement's own resolution (a wall screen's samples sit
`sqrt(area / sampleCount)` apart), and the tool says so in the band's `source`.

**1. The trust ladder — always the weakest honest label.** Every rule carries
`source.kind`, in descending trust:

`measured` (your own coupon, with date + machine + coupon id) > `vendor-spec` (the
machine or material vendor's published limit) > `standard` (a published standard) >
`literature` > `rule-of-thumb` > `assumed`.

**Never upgrade a label.** A number you half-remember from a forum is `rule-of-thumb`, not
`literature`. A number you invented to make the tool run is `assumed`, and saying so is
what keeps the report honest — the reader can then discount it.

**2. A draft is a hypothesis with a name.** When you draft a profile for someone who has
not calibrated anything, say so in `notes`, mark the numbers `assumed`, and tell them
**which numbers are worth calibrating first** — the margin tells you: the rules whose
measured value sits within one resolution step of the requirement are the ones that
actually decide this part. Do not present a draft as a standard.

**3. Two modes, one tool.** `mode: 'judge'` (default) returns the verdict/profiles only;
`'scan'` returns the sampled field only and **no verdict**; `'both'` returns both. The run
always records both halves — the mode trims the reply, not the record.

**3b. Validate by using it.** Pass the draft to `check_printability` (`profilesJson`). An
invalid profile is REFUSED with the offending rule named — there is no separate validator
tool, and no partial application: a profile with one bad rule is not "mostly fine".

**4. Calibrate cheaply, and record it.** The cheapest calibration is a ladder coupon:
generate it, print or cut it, measure it, record the result as `measured`. A wall ladder
is a few lines — vary one dimension in steps that bracket the number you care about:

```scad
// Wall ladder: 5 walls from 0.6mm to 1.8mm in 0.3mm steps. Print, then find the
// thinnest one that comes out solid and clean — that is your measured wallMinMm.
for (i = [0:4]) translate([i * 6, 0, 0]) cube([0.6 + i * 0.3, 20, 10]);
```

A gap ladder (vary a slot width to find the smallest that clears) calibrates
`escapePassageMinMm` and `toolRadiusMm` the same way. Record date, machine and coupon id
in `source.ref` — a `measured` number without a coupon is not evidence, it is a memory.

**5. Explain every witness; never invent a remedy.** A witness is `{rule, location,
measured, required}`. Handing that over raw is a puzzle, not a finding. Always add: what
the number means physically, and what the geometry would have to become. But **do not
propose a remedy you cannot justify from the geometry** — "widen the drain to Ø3" is fine
when the bore diameter is the witness; "switch to SLS" is a business decision the tool
must not make for the user.

**6. Never rank, never recommend — even when asked directly.** Give the comparison across
profiles (each with its own two-valued verdict and witnesses) and let the user decide.
If they ask "which should I use?", the honest answer is which constraints each one
imposes and what the margins are, plus the non-geometric questions only they can answer
(cost, lead time, quantity, their shop's capability).

**7. What the tool will never do for you.** It will not choose a process, will not supply
numbers, and will not treat a missing number as "no constraint" — an undeclared rule comes
back in `unevaluable`, and `not-excluded` always means "no geometric counter-example was
found", never "this can be made".
