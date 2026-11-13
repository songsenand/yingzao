# From description to delivery

One complete pass through the tool. Every step says what you see, what you decide, and what you must **not** assume.

## Before you start

- Start a new session with the **营造模式 (Yingzao mode)** preset. A normal coding session does not see CAD tools on purpose: it should not pay the tool-table cost for an unused plugin.
- The first calculation downloads a ~400 MB runtime (a few minutes), shared by all projects afterwards.

## 1. Describe

A good description usually has five parts:

| Element | Example |
|---|---|
| Function | A mounting plate carrying a 20 mm bearing |
| Dimensions | 60×40×8 mm |
| Interfaces | Four M3 countersunk holes, one 20 mm centre hole, spacing 50×30 |
| Process | FDM / PLA, 0.4 mm nozzle |
| Acceptance | Bearing presses in without wobble; bottom face must be flat |

You do not need all five at once. Fill gaps later — but the earlier you state **process and acceptance**, the more meaningful later checks are.

## 2. Generate and self-check

The agent writes geometry code, compiles, renders four views, and **reads the images itself** before showing you.

You see:

- a new **version** (`v001`, `v002`, …); old versions remain;
- four views plus bounding-box dimensions;
- a warning if the mesh is open or has multiple disconnected solids.

**Do not assume** the first version is final. Treat it as a representative part: confirm its shape and key features first, then ask for the rest of the family.

## 3. Review

Look at the model in the right-hand **panel**. Ask three questions in order:

1. **Is the shape right?** Orbit around it; compare with the function you described; is anything extra or missing?
2. **Are the fits right?** Measure hole spacing, wall thickness, clearance; box the areas you doubt.
3. **Does it move right?** For a mechanism, replay the trajectory; pause on a suspicious frame and point at it.

The more specific the feedback, the better:

- Good: “Change the centre hole to 22, keep it perpendicular to the bottom, everything else unchanged.”
- Bad: “It feels wrong.”

## 4. Iterate

Every edit creates a new version. You can:

- compare views and numbers between two versions;
- pin one revision as a baseline;
- revisit any old version; nothing is lost.

**Preserve intent**: say what changes and what must not. For example, “hole to 22, keep spacing and outline” — otherwise the agent may change something else.

## 5. Verify

Run checks when needed. Four families, chosen by your question:

| You want to know | Check | You see |
|---|---|---|
| Is the part itself right? | geometry / printability | dimensions, wall thickness, overhang, single solid |
| Is the assembly right? | assembly check | per-interface results, clearance, **undeclared** neighbours |
| Does the mechanism move / collide? | motion | trajectory, interference timeline, stroke |
| Does fluid flow? | fluid | particle replay, trend numbers |

How to read a report (excluded / difficult / not excluded / not evaluated): [Verification](verification.md#reading-a-report). Every “excluded” names a location and “measured vs required”; go look at that point in the panel.

## 6. Deliver

When satisfied, export. A single version can be STL / 3MF / OBJ / OFF / WRL. For a whole project use **Project ZIP** — every part STL + assembly manifest + README (plus a placed `assembly.stl` when a manifest exists), or **Project STL** to merge the placed assembly into one multi-shell mesh (no boolean union; appropriate for preview/quoting).

Before delivery, confirm:

- every part has a printability check under the process you declared;
- every declared interface has a result, not “skipped”;
- the claim you want to make (“this assembly fits”, “this part prints”) has a corresponding check record, not just a render.

## 7. You already have files

See [Advanced usage · importing existing files](advanced.md) (preview, import as version, one-object 3MF, DXF depth, import by path).

## A “do not assume” list

- Do not assume “looks good” = printable.
- Do not assume “not excluded” = accepted.
- Do not assume “no error” = checked (look for “not evaluated / skipped”).
- Do not assume the first version is right (review a representative part first).
- Do not assume changing one dimension leaves everything else alone (read the new report).
