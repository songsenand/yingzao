# What it is, and what it is not

[中文](../../user/what-is-yingzao.md) | English

**Describe a part in natural language; get a model that has been checked and can be printed.**

## It is not about “generation”

Generating geometry is no longer hard. **Knowing whether the result is correct** is: dimensions, wall thickness, fits, motion, printability. A system that generates but cannot verify produces things that only *look* right.

So the loop is:

> describe → generate → agent self-check → **you review** → verify → deliver

Every step leaves evidence you can revisit: immutable versions, four views, numeric reports, motion replay, check records.

## What you see

- **Versions**: every generation or edit is a new version; old ones never disappear. Compare, pin, revisit.
- **Four views**: top/front/side/iso. No axes or dimension lines, so the bounding-box numbers sit next to them.
- **Panel**: the 3D view on the right. Orbit freely, measure two points, box a suspicious area, pause a replay and point.
- **Report**: the result of one check. It says “excluded / difficult / not excluded”, and lists what was **not evaluated**.
- **Replay**: a timeline for motion or fluid trends; stop on a frame and look.

## What you decide

The tool provides truth; **judgement stays with you**. Three typical calls:

1. **Intent**: is a 0.75 mm gap a fit or a defect? It depends on how the part should move.
2. **Trade-offs**: wall thickness, weight, print time, assembly difficulty — the tool will not rank them for you.
3. **Acceptance**: can this revision ship? The tool can say “no counterexample found”; it cannot say “guaranteed manufacturable”.

## What it is not

- **Not a modelling UI.** You do not sketch or extrude; you describe, the agent writes code.
- **Not an automatic certificate.** “Not excluded” means no geometric counterexample was found; it does not mean manufacturable or certifiable.
- **Not industrial CAD/FEA/CFD.** No B-rep, no engineering drawings, no certified accuracy; stress and fluid are trends, not guarantees.
- **It does not repair bad meshes.** Bad geometry is rejected with the location of the problem, not turned into a confident wrong number.
- **Not multi-user/cloud/mobile.** A local single-user tool.

## An example

You say:

> Make a 60×40×8 mounting plate, four M3 countersunk holes, one 20 mm through hole in the centre.

The agent generates, compiles, renders, and reads the images first; you see the plate, four countersinks and the centre hole. Then you can:

- measure hole spacing and wall thickness;
- say “change the hole to 22, keep it concentric” and get a new version;
- ask for a printability check and read where it is too thin;
- export STL when satisfied.

## Where to start

- First use: [From description to delivery](workflow.md).
- What it cannot do: [Limits](limits.md).
- Install/troubleshooting: [README.en.md](../../../README.en.md).
