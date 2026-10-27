# 约定：每个工具默认的坐标系、datum、清单与运行

> 长解释参考；短规则在 `skills/cad-toolbox/SKILL.md`。


## Conventions every tool assumes

- **Millimetres, z-up.** No tool takes a unit argument.
- **`generate_part` renders are the review channel** — look at all four views
  (front/side/top/iso) before claiming a shape is right. Renders are for
  *shape*; numbers come from `measure_*`.
- **Anchors**: declare `datum("name", [x,y,z])` at top level, in **final world
  coordinates** (a transform at the call site does not move the echoed value).
  Datums do not affect the mesh. Extended kinds exist for assemblies:
  `datum_axis`, `datum_plane`, `datum_cyl`.
- **Anchors are declarations, not metadata.** If you forgot one, or need the exact
  names and coordinates to write an interface against, use `set_datums` on the
  version you already have — `set_datums(versionId)` lists, `set_datums(versionId,
  datums)` records. Recording creates a **new version** (parent = the one you gave;
  the mesh is copied byte-for-byte, so no renders and no recompile): an interface
  RESOLVES against an anchor, so moving it in place would change what old runs meant.
  Point your manifest at the returned version id. Do **not** spend a `generate_part`
  round on a version whose only change is an anchor — that costs four renders and
  rewrites the geometry for nothing.
- **The assembly manifest is an ordinary file in your workspace**, by default
  `<workspace>/assembly/assembly.json`, and `check_assembly` resolves a relative
  `manifestPath` against the workspace first (the plugin data root is only a
  fallback for old corpora). Author and edit it with `write` / `edit` like any
  other source file — do not shell out to patch JSON, and never copy it anywhere.
- **BOSL2 is available** in `generate_part` (`std.scad`, plus `screws.scad`,
  `gears.scad`, `walls.scad`, `threading.scad`, `sliders.scad`,
  `ball_bearings.scad`). Use the library module instead of hand-rolling a thread,
  a gear or a fillet.
- **`judge` / `scan` / `both`.** The judgement tools (`check_printability`,
  `simulate_stress`) take `mode`: `judge` (default) returns the verdict and NO
  field, `scan` returns the field and NO verdict, `both` returns both as separate
  keys. The RUN always records both halves — the mode trims the reply, not the
  record. In `judge` mode the reply still carries `nextLook`: runnable observations
  (`{tool, args, why}`) for this same version, because a verdict without a place is
  the failure HARNESS §11.14 exists to prevent.
- **Rigid simulation costs seconds, fluid costs minutes.** Ask for the cheap
  check first.
- **Images are the biggest context spend.** Each attached render lives in your
  context for several rounds before the budget prunes it. New or reshaped parts
  deserve all four views; a numeric iteration (a hole Ø, a length you will
  verify with `measure_*`) does not — pass `views: ["iso"]` to `generate_part`
  and keep the budget for the screenshots that carry information.
- **A reference image the user attached will be pruned from your context** after
  roughly five render rounds (the oldest images go first, and theirs is the
  oldest). The first user message then carries a placeholder naming the local
  file. Before you claim a shape matches the reference — and again before you
  finish — `read_image` that path and look at it. Designing "from the picture"
  while the picture is no longer in view is how a machine ends up with the wrong
  silhouette and a green assembly check.

