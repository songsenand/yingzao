# LLM documentation

[中文](../../llm/README.md) | English

This is the reference layer for **agents**. User docs live in `docs/user/`; do not mix them.

## Reading order

1. **`skills/cad-toolbox`** — read the router first: which question belongs to which tool, and what each output family may claim.
2. **`docs/en/llm/` (this directory)** — read deeper when needed: engine boundaries, traps, delivery discipline, coordinate/manifest conventions.
3. **`docs/TOOL-CONTRACTS.md`** — the **single authority** for parameters and fields (generated; do not hand-edit).
4. **`HARNESS.en.md` / `DESIGN.md`** — only when the question is “why was it designed this way?”.

## In this directory

| File | Content | Status |
|---|---|---|
| `engines.md` | Boundaries of motion/physics/fluid/LBM/stress, and what they cannot answer | present |
| `assembly.md` | Manifest shape, operators, pose, thresholds, imported parts/stock | present |
| `manufacturing.md` | Printability checklist, process profiles, trust ladder, calibration, sealed cavities/tool reach | present |
| `processes.md` | Process catalogue: `allowed` decision space vs `support` evaluator; planned/partial tiers and handoff | present |
| `modeling.md` | Import formats/units, merge/genus, OpenSCAD degrees/radians, twist, reference images | present |
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
| Parameters, fields, return shape | `docs/TOOL-CONTRACTS.md` (generated) |
| Which tool, when | `skills/cad-toolbox` |
| Field meaning and traps | this directory + tool descriptions |
| Current design/architecture | `DESIGN.md` |
| Historical choices | `docs/DECISION-LOG.md` (append-only) |

One fact is defined in one place; elsewhere only a link.
