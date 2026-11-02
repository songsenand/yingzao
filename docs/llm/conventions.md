# 约定：每个工具默认的坐标系、datum、清单与运行

> 长解释参考；短规则在 `skills/cad-toolbox/SKILL.md`。


## Conventions every tool assumes

- **Millimetres, z-up.** No tool takes a unit argument.
- **A CAD project must be selected EXPLICITLY; there is no default cwd/root.** The first corpus-needing CAD tool in a session refuses until the session selects one: `bind_project({dir:"..."})` for an existing `cad-data/project.json` (or legacy `cad-data/`), or `init_project({dir:"..."})` for a new project (if unbound, it also selects the new marker; if already selected, it does not rebind). `dir` is required; there is no live-cwd default. `cd` never switches. `project_info` reports `selected`, `boundRoot`, `mismatch`, `ambiguous`, `workspace`; an empty path is `selected:false`, not a fallback. A workspace root (`cad-workspace.json`) is a container, never a write target. The panel has no "follow session" and no default root: the project path must be chosen explicitly, and an empty path reads nothing. If a task needs to switch projects in one session, move/rename a project, share it between people, or write to two projects, stop and tell the user this is the C-lite gap (C/D are deferred); do not fork a corpus (a copied corpus is still a fork) or add symlinks.
- **`generate_part` renders are the review channel** — look at all four views
  (front/side/top/iso) before claiming a shape is right. Renders are for
  *shape*; numbers come from `measure_*`. `views: []` is no longer a way to
  skip this: a version registered with no image is overridden to top+iso with
  a warning.
- **Delivery needs a separate, per-version visual review.** Call
  `review_visual` on every printed part's exact version (top+iso, plus a
  section for an internal feature) and write a note saying what you checked.
  `delivery_audit` blocks the newest printed part if the record is missing or
  older than the version. A review of the parent does not cover a shape
  change; re-review after a fix.
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
- **`analyze` can fuse ONE stress run.** Pass `stressRunId`; the run must cite the
  version. `strength` is the absolute warn/bad layer (safe to be silent), while
  `strength-concentration` carries the run's local peaks at `|u|=0.5` — a LOOK, not a
  risk. Without a run, strength is `notMapped`, never 0. `cellMm` controls clustering:
  a long corner chain needs a cell large enough to merge its stress peaks (the 40mm
  V-notch root: 8mm kept 6 separate peaks; 16mm merged the corner and the nearest one,
  count 2).
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

