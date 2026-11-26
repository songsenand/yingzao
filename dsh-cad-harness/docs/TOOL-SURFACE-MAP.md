# Tool surface map (generated — do not edit by hand)

> `node scripts/audit-tool-surface.mjs --write`
>
> **Frozen** 2026-11-26, revision 1 (2026-11-26).
> Under the 0.2.0 contract the nine surface names and every action name below are
> **frozen: add only**. `docs/TOOL-SURFACE-V1.json` is the machine copy this page is
> rendered from; `accept-tool-surface` and `accept-cad-all-surfaces` compare the live
> registration against it.

## Deprecation policy (0.2.x)

1. **Add**: add the tool, declare `surface: { id, action }`, run
   `node scripts/audit-tool-surface.mjs --write`, commit the ledger diff with the code.
   The new pair appears in `docs/TOOL-SURFACE-V1.json`; nothing else changes.
2. **Deprecate**: keep the pair in the ledger and mark it deprecated in the tool
   description plus `docs/TOOL-CONTRACTS.md`; the action keeps working and keeps its
   name for at least one minor version.
3. **Remove**: only after step 2 has shipped in a released minor. `--write` refuses to
   drop a frozen pair; the deliberate removal needs `--force` **and** a changelog line
   naming the released version that carried the deprecation.
4. **Rename**: never in place. Add the new action (step 1), deprecate the old one
   (step 2), remove it later (step 3) — a rename is two deprecations away, by design.

The full forward-compatibility contract (project schema, CLI/env stability, golden
project regression) is `docs/dev/COMPATIBILITY.md` (Q3); this page is the tool-surface
half of it.

## Legacy name → surface call

Every pre-cutover tool keeps its implementation; only the call changes.
Call the surface/action on the right, not the tool on the left.

| legacy tool | call it as |
|---|---|
| `affected_checks` | `cad_deliver` action `affected` |
| `analyze` | `cad_inspect` action `analyze` |
| `attach_appearance` | `cad_part` action `appearance` |
| `bind_project` | `cad_session` action `bind` |
| `check_appearance` | `cad_check` action `appearance` |
| `check_assembly` | `cad_assembly` action `check` |
| `check_cnc_access` | `cad_check` action `cnc` |
| `check_edm_access` | `cad_check` action `edm` |
| `check_parts` | `cad_check` action `parts` |
| `check_printability` | `cad_check` action `printability` |
| `check_sheet2d` | `cad_check` action `sheet2d` |
| `check_sweep` | `cad_check` action `sweep` |
| `check_turning` | `cad_check` action `turning` |
| `create_part` | `cad_part` action `create` |
| `deliver` | `cad_deliver` action `plan` |
| `delivery_audit` | `cad_deliver` action `audit` |
| `generate_part` | `cad_part` action `generate` |
| `import_part` | `cad_part` action `import` |
| `init_project` | `cad_session` action `init` |
| `list_features` | `cad_inspect` action `features` |
| `measure` | `cad_inspect` action `measure` |
| `merge_parts` | `cad_part` action `merge` |
| `pearl_run` | `cad_deliver` action `pearl` |
| `preflight` | `cad_deliver` action `preflight` |
| `project_info` | `cad_session` action `info` |
| `python_runtime` | `cad_python` action `runtime` |
| `recall_reference_image` | `cad_see` action `reference` |
| `render_part` | `cad_see` action `render` |
| `request_review` | `cad_session` action `review` |
| `retire_run` | `cad_deliver` action `retire` |
| `review_visual` | `cad_see` action `review` |
| `run_python` | `cad_python` action `run` |
| `scan_attention` | `cad_inspect` action `attention` |
| `scan_stress_hotspots` | `cad_simulate` action `hotspots` |
| `set_datums` | `cad_assembly` action `datums` |
| `set_part_role` | `cad_part` action `role` |
| `set_project_kernel` | `cad_session` action `kernel` |
| `simulate_fluid` | `cad_simulate` action `fluid` |
| `simulate_lbm` | `cad_simulate` action `lbm` |
| `simulate_motion` | `cad_simulate` action `motion` |
| `simulate_physics` | `cad_simulate` action `physics` |
| `simulate_stress` | `cad_simulate` action `stress` |
| `suggest_interfaces` | `cad_assembly` action `suggest` |
| `validate_assembly` | `cad_assembly` action `validate` |
| `write_assembly` | `cad_assembly` action `write` |

## Ops per surface

| surface | ops | actions |
|---|---|---|
| `cad_assembly` | 5 | `check`, `datums`, `suggest`, `validate`, `write` |
| `cad_check` | 8 | `appearance`, `cnc`, `edm`, `parts`, `printability`, `sheet2d`, `sweep`, `turning` |
| `cad_deliver` | 6 | `affected`, `audit`, `pearl`, `plan`, `preflight`, `retire` |
| `cad_inspect` | 4 | `analyze`, `attention`, `features`, `measure` |
| `cad_part` | 6 | `appearance`, `create`, `generate`, `import`, `merge`, `role` |
| `cad_python` | 2 | `run`, `runtime` |
| `cad_see` | 3 | `reference`, `render`, `review` |
| `cad_session` | 5 | `bind`, `info`, `init`, `kernel`, `review` |
| `cad_simulate` | 6 | `fluid`, `hotspots`, `lbm`, `motion`, `physics`, `stress` |

Budget: the nine surface schemas must stay ≤ 6144 chars (Q1).
