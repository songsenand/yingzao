# Install and first run

[中文](../../user/install.md) | English

## Requirements

| Requirement | Notes |
|---|---|
| **dsh** (with the Web GUI) | The plugin is installed into a dsh profile |
| **Node ≥ 20 + pnpm** | For install/runtime; tarball users do not build, but dsh still uses pnpm internally |
| **OpenSCAD** | Prepared by `setup --openscad=auto`; an existing 2025.06+ system install is used as-is. Official snapshot first; the OSS mirror is used only when the official source is unreachable or stays below 256 KB/s. You can also point `CAD_OPENSCAD_BIN` at a binary |
| **BOSL2** | Optional standard-parts library (gears/threads/screws/walls). Download it yourself into `lib/BOSL2/`; it is not shipped |
| **Python** | **Not shipped.** The first analysis/simulation downloads about 400 MB into `$DSH_HOME/cad/runtime/` |

The preview does **not** bundle OpenSCAD, BOSL2 or the Python runtime. OpenSCAD is provisioned as a portable download (official first, OSS mirror fallback) or reused from the system; the plugin calls it through a process boundary.

## Install

### A. Tarball (preview release; no build)

```bash
tar -xzf dsh-cad-harness-0.1.0.tgz
dsh plugin --profile <your-profile> add -w "$PWD/package"
cd package
npx dsh-cad-setup --openscad=auto
npx dsh-cad-doctor
npx dsh-cad-backend --show
```

### B. Source checkout (development)

```bash
dsh plugin --profile <your-profile> add -w /path/to/dsh-cad-harness
cd /path/to/dsh-cad-harness && pnpm install && pnpm run build
npm run setup
npx dsh-cad-doctor
```

After changing host code you must rebuild `lib/` and restart dsh (the host bundle is not hot-reloaded). Tarball users do not need this.

`npx dsh-cad-setup --openscad=auto` (or `node scripts/setup.mjs --openscad=auto` in a checkout) rewrites `presets/cad/preset.patch.yml` with **this machine's** `skills/` path and provisions OpenSCAD. `--openscad=off` writes the preset only; `--openscad=official` / `mirror` force one source. `npx dsh-cad-setup --check` writes nothing and exits 1 when the path is stale or a skill directory is missing. Restart dsh afterwards.

Then check the environment:

```bash
npx dsh-cad-doctor          # kind=ok, or an explained degraded (e.g. OpenSCAD 2021)
npx dsh-cad-backend --show  # kernel=openscad, compileBackend=auto
```

`dsh-cad-backend` is the kernel / compile-backend entry point. The preview ships only the OpenSCAD adapter; `cadquery` / `freecad` are listed as `planned` and cannot be selected.

> Exact flags follow the `dsh plugin --help` of the dsh version you run.

## Turn it on

Start a new session and choose the **营造模式 (Yingzao mode)** preset — or make it the default in Settings.

**Why is this required?** CAD tools are visible only to that preset: a normal coding session should not pay the tool-table cost for an unused plugin. In a standard session the panel says “this session has no CAD tools” instead of showing an empty list.

## First run (~400 MB, a few minutes)

The first calculation downloads a **private Python runtime** into `$DSH_HOME/cad/runtime/`, shared by all projects.

- **Why**: geometry analysis, exact measurement, physics/motion and fluid trends need scientific Python; the machine cannot be assumed to have a clean one.
- **Warm it early**: ask the agent to run `python_runtime` action `provision` (with progress), or set `DSH_CAD_PYTHON=eager`.
- **Use system Python**: `DSH_CAD_PYTHON=system` uses an existing CPython (currently 3.13); dependencies are still installed from the lock.
- **Cost**: about 380–400 MB; 3–11 minutes depending on network. Mirrors/indexes can be changed.

## BOSL2

If `include <BOSL2/std.scad>` fails, `OPENSCADPATH` must point at the directory that **contains** `BOSL2/` (usually `lib/`), not at `lib/BOSL2` itself. `dsh-cad-harness/scripts/accept-bosl2.mjs` checks the wiring.

## Verify the install

Start a **营造模式 (Yingzao mode)** session and say:

> Make a 20 mm cube.

A new version with four views means the install works. If not, see [troubleshooting](../../user/troubleshooting.md) (Chinese) or run `npx dsh-cad-doctor --json`.
