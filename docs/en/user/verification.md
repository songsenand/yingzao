# Verification

The tool provides **truth**; judgement stays with you. Below: what it answers, what you see, and what it **cannot** prove.

## Five layers

| Layer | Answers | You see |
|---|---|---|
| Geometry | Are dimensions right, walls thick enough, any interference, one connected solid? | numbers + report card |
| Assembly | Who mates with whom, clearance, any **undeclared** neighbours? | per-interface results |
| Rigid body / mechanism | Will it topple, collide during motion, is the stroke enough? | trajectory and timeline replay |
| Fluid | Does it flow, where are dead zones? | particle replay + trend numbers |
| Process | Under **your declared process** (FDM/SLA/SLS/…), can this be made? | excluded processes + counterexamples; no recommendation |

## Reading a report

- **Excluded**: a counterexample was found (e.g. a 0.2 mm wall below your declared 0.4 mm nozzle). The hardest conclusion.
- **Difficult**: something suspicious, or the margin is inside measurement noise. Not a pass.
- **Not excluded**: no geometric counterexample found. **Not the same as manufacturable**, and not “safe”.
- **Not evaluated / skipped**: this item was not checked. **Not evaluated is not a pass.**

Every “excluded” names a location and “measured vs required”; go look at that point in the panel.

## What it cannot prove

- No **certificate**, safety factor or lifetime;
- No certified accuracy or industrial tolerances;
- Not a substitute for professional FEA / CFD acceptance data;
- It does not choose process/material for you (that is a business decision).

## Flow

How checks fit into a complete use: [From description to delivery](workflow.md).
