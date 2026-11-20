# LLM documentation

[中文](../../llm/README.md) | English

This is the reference layer for **agents**. User docs live in `docs/user/`; do not mix them.

## Call surface (since 2026-11-16)

A production session exposes **9 surfaces / 39 ops**. The call form is `cad_<surface>({ action: "<op>", args: { … } })`; this directory uses that form. Legacy tool names (`generate_part`, `check_assembly`, …) are internal op names; calling them directly fails with `unknown tool`.

| surface | actions |
|---|---|
| `cad_session` | `info` · `init` · `bind` · `review` |
| `cad_part` | `create` · `generate` · `import` · `merge` · `role` · `appearance` |
| `cad_assembly` | `write` · `validate` · `check` · `datums` |
| `cad_check` | `printability` · `sheet2d` · `turning` · `cnc` · `edm` · `parts` · `appearance` |
| `cad_simulate` | `physics` · `motion` · `fluid` · `lbm` · `stress` |
| `cad_inspect` | `measure` · `features` · `attention` · `analyze` |
| `cad_see` | `render` · `review` · `reference` |
| `cad_python` | `run` · `runtime` |
| `cad_deliver` | `plan` · `preflight` · `audit` · `pearl` (deprecated) |

`catalog` / `help` are read-only actions on every surface: `catalog` lists the ops, `help` gives the legacy parameters.

## Reading order

1. **`skills/cad-toolbox`** — read the router first: which question belongs to which tool, and what each output family may claim.
2. **`docs/en/llm/` (this directory)** — read deeper when needed: engine boundaries, traps, delivery discipline, coordinate/manifest conventions.
3. **`dsh-cad-harness/docs/TOOL-CONTRACTS.md`** — the authority for each internal op's parameters and fields (generated; do not hand-edit; call names are the table above).
4. **`HARNESS.en.md` / `DESIGN.md`** — only when the question is “why was it designed this way?”.

## In this directory

| File | Content | Status |
|---|---|---|
| `engines.md` | Boundaries of motion/physics/fluid/LBM/stress, and what they cannot answer | present |
| `assembly.md` | Manifest shape, operators, pose, thresholds, imported parts/stock | present |
| `manufacturing.md` | Printability checklist, process profiles, trust ladder, calibration, sealed cavities/tool reach | present |
| `processes.md` | Process catalogue: `allowed` decision space vs `support` evaluator; planned/partial tiers and handoff | present |
| `modeling.md` | Import formats/units, merge/genus, OpenSCAD degrees/radians, twist, reference images | present |
| `library.md` | 99-item standard-parts catalogue, fit/visual, BOSL2 vs spring seed, and the current lack of a tool entry | present |
| `delivery.md` | Delivery discipline: claims, evidence, coverage, representative parts | present |
| `conventions.md` | mm/z-up, datum, manifest, judge/scan/both, run | present |
| `traps.md` | Long-form traps (rack pitch, pivot, lattice units…) | present |
| `verify.md` | V1 evidence verification: six rows, status, claims/freshness, policy, exit codes | present |
| `pearls.md` | Historical: six-pearl gate/execute (superseded by `verify`; not a path) | historical |

## Writing rules

- **Imperative**: say what to do / not do / check, not the history of a tool.
- **Every line changes a decision.** Explanations of “why” belong in `DESIGN.md` / `DECISION-LOG.md`.
- **No install, marketing or tutorials**; those live in `docs/user/` and the root `README.md`.
- **Do not copy field tables**; fields live in `TOOL-CONTRACTS.md`. Here write what a field means and when it cannot be trusted.
- **Long explanations here, short rules in the skill.** Every skill rule should point at a section here.

## Authority order

| Fact | Authority |
|---|---|
| Call names / actions | the table above + `skills/cad-toolbox` |
| Parameters, fields, return shape | `dsh-cad-harness/docs/TOOL-CONTRACTS.md` (generated; indexed by internal op name) |
| Which tool, when | `skills/cad-toolbox` |
| Field meaning and traps | this directory + tool descriptions |
| Current design/architecture | `DESIGN.md` |
| Historical choices | `docs/DECISION-LOG.md` (append-only) |

One fact is defined in one place; elsewhere only a link.
