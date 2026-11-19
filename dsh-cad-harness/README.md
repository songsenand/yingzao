# dsh-cad-harness

**The agent generates. The plugin closes the loop.**

A dsh plugin for mechanical CAD — fit, motion and manufacturability checked before
you accept a model, and the final call left to you.

| Part | Assembly | Motion |
|---|---|---|
| ![M8 bolt and nut](https://cdn.jsdelivr.net/gh/songsenand/yingzao@main/docs/images/readme/m8-bolt-nut.png) | ![Three-stage 64:1 spur reducer](https://cdn.jsdelivr.net/gh/songsenand/yingzao@main/docs/images/readme/reducer-64.png) | ![DN100 ball valve, 90° travel](https://cdn.jsdelivr.net/gh/songsenand/yingzao@main/docs/images/readme/ball-valve-90.gif) |
| Real **M8×1.25** thread, about **5.2 turns** engaged | 24 instances / 276 pairs, **0 interference**, ratio **64.000** | **0→90°** travel, 24/24 poses, **0 interference** |

## Install

```bash
dsh plugin --profile <profile> add dsh-cad-harness
npx dsh-cad-setup --openscad=auto   # preset + OpenSCAD
npx dsh-cad-doctor                  # kind=ok, or an explained degraded
```

`setup` writes this machine's skill path into the preset; an absolute path from the
packing machine would be wrong here, so the package ships without it. Restart dsh,
then start a session with the 「营造模式」 preset.

**After a dsh upgrade, run `npx dsh-cad-setup` again and restart.** The preset is a
verbatim copy of dsh's `standard.patch.yml`, and dsh removes or renames internal rows
between releases. A preset mounts as a whole: one stale row and the 「营造模式」 mode
does not appear at all — no error, just a missing mode. `npx dsh-cad-doctor` reports
`preset-standard-drift` and names this fix.

> pnpm 12 prints `Agent skills awaiting approval: dsh-cad-harness` on first install.
> That is its approval prompt for the skills shipped in the package, not a failure.

## Requirements

- Node.js >= 20
- dsh, with the CAD bundle enabled for the profile
- OpenSCAD on `PATH` (or `CAD_OPENSCAD_BIN`); 2021.01 works but `doctor` reports
  `degraded` — the same model measured 2467 ms on it against 69 ms on a Manifold
  build. 2025.06+ enables the Manifold backend; `npx dsh-cad-provision` installs the
  pinned snapshot
- BOSL2 optional, under `lib/BOSL2/` in the source checkout
- Python runtime is provisioned on first use (about 400 MB)

## Documentation

The user guide, Agent reference, and maintainer notes live in the source
repository under `docs/` (`docs/user/`, `docs/llm/`, `docs/dev/`). This tarball
keeps the package-local `docs/` (tool contracts) so the bundle is inspectable.

## License

Apache-2.0. Third-party notices are in the repository `NOTICE`.
