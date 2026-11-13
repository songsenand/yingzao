# Yingzao (营造) · dsh-cad-harness

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](docs/en/user/install.md)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](docs/en/user/limits.md)
[![Status](https://img.shields.io/badge/status-0.1.0%20preview-orange.svg)](docs/en/user/preview.md)

[中文](README.md) | English

> **Yingzao (营造) — describe a part in natural language, get a model that has been checked and can be printed.**

This is not a modelling UI. Geometry generation is no longer the bottleneck; **knowing whether the result is correct** is. A system that can generate but cannot verify produces things that only "look right". This plugin closes the loop **generate → verify → iterate → deliver**, and keeps the judgement calls with the human.

- The agent writes code, compiles, renders, and **reads the images itself** before presenting a result
- The engine returns **numbers**: dimensions, volume, wall thickness, clearance, interference, motion stroke, fluid trends
- Every revision is an **immutable version** you can browse, pin and compare
- Third-party geometry (STL / STEP / 3MF / DXF) enters the same checks and assemblies
- Export a **single version** (STL/3MF/OBJ/OFF/WRL) or the **whole project**: a ZIP with every part STL + assembly manifest + README, plus an optional placed whole-machine STL

**Docs have three audiences**: users → [docs/user/](docs/user/) (Chinese; English subset under [docs/en/user/](docs/en/user/)), agents → [docs/llm/](docs/llm/), maintainers → [docs/dev/](docs/dev/).

## Quick start

Install OpenSCAD first. 2021.01 works but `doctor` reports `degraded`; 2025.06+ is recommended for the Manifold backend.

**A. Tarball (preview release; no build)**

```bash
tar -xzf dsh-cad-harness-0.1.0.tgz
dsh plugin --profile <your-profile> add -w "$PWD/package"
cd package
node scripts/setup.mjs     # writes this machine's skill path into the preset
node scripts/doctor.mjs    # kind=ok, or an explained degraded
```

**B. Source checkout (development)**

```bash
dsh plugin --profile <your-profile> add -w /path/to/dsh-cad-harness
cd /path/to/dsh-cad-harness && pnpm install && pnpm run build
npm run setup
node scripts/doctor.mjs
```

Then read the [0.1.0 preview notes](docs/en/user/preview.md), start a session with the **营造模式 (Yingzao mode)** preset, and describe the part:

> Make a 60×40×8 mounting plate, four M3 countersunk holes, one 20 mm through hole in the centre.

Next:

- Full workflow and the decisions you own → [workflow](docs/user/workflow.md) (Chinese)
- What each verification layer answers → [verification](docs/user/verification.md) (Chinese)
- What it cannot do yet → [limits](docs/en/user/limits.md)
- Install, first run, troubleshooting → [install](docs/en/user/install.md) / [troubleshooting](docs/user/troubleshooting.md) (Chinese)

## Evidence verification (V1)

```bash
cd dsh-cad-harness
node scripts/verify.mjs /path/to/project --advisory
node scripts/verify.mjs /path/to/project --block --strict
```

`verify` is read-only: it checks the six rows `requirements / model / fit / make / review / delivery`, reports missing/stale evidence and claim witnesses, and never runs CAD, writes a run, or judges the design.

- Default advisory (exit 0); `--block`: pass 0 / warn 1 / blocked|fail 2 / usage 3; `--strict` turns warn into 2.
- Claims: `<project>/claims.json` or `--claims <file>`; policy: `<project>/evidence-policy.json` or `--policy <file>`. No policy means advisory.
- Project-specific criteria live in `<project>/checks/<id>/`; register with `check-register`, enable with `--checks`. Negative samples must pass the gate; write to the project invalidates the check.
- Details: [docs/llm/verify.md](docs/llm/verify.md) (Chinese).

## Documentation map

| Document | What it covers |
|---|---|
| [README.md](README.md) | Chinese entry point; authoritative for the project |
| [docs/en/user/preview.md](docs/en/user/preview.md) | 0.1.0 preview scope and known limits |
| [docs/en/user/install.md](docs/en/user/install.md) | Install, setup, first run |
| [docs/en/user/limits.md](docs/en/user/limits.md) | Known boundaries |
| [HARNESS.md](HARNESS.md) | What it is and is not; positioning (Chinese) |
| [DESIGN.md](DESIGN.md) | Current design and module map (Chinese) |

The English documentation is a **subset** for this preview: entry point, install, preview notes and limits. User guides, agent reference and maintainer docs remain Chinese until preview.2.

## Contributing

- Every commit must be signed off (`git commit -s`, DCO 1.1); DCO is not a CLA.
- Commit messages follow [AGENTS.md](AGENTS.md): `Why` / `Verified` / `Risk` (plus `Decision` when a direction was chosen). `Verified` must name a falsifiable observation.
- Directional decisions go to [docs/DECISION-LOG.md](docs/DECISION-LOG.md) (append-only).
- Third-party assets in the benchmark corpus are materialised at use time, never committed (see [examples/bench/ATTRIBUTION.md](examples/bench/ATTRIBUTION.md)).
