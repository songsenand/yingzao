[English](../en/llm/pearls.md) | 中文

# Pearls: gate, execute, and what "repair" may mean

> **Historical (2026-11-06).** The pearl execution layer is demoted; V1 evidence verification
> supersedes it on the model-facing surface. Decision:
> `docs/PEARL-TO-VERIFY-DECISION-2026-11-06.md`. Kept as an implementation record.

A pearl answers one question. Six pearls: `brief`, `model`, `fit`, `make`, `review`,
`deliver`. A template is the task-class implementation; a rule pack supplies domain
rules; `pearl-profile.json` selects pearl + template + rule pack.

## Two contracts

- `assembly/assembly.json` — geometry/interface truth; owned by `model`/`fit`.
- `necklace-contract.json` — thin index over the six pearls: status, evidence,
  failures, pinned assembly hash, `next`. It does not store geometry.

A written necklace contract is `stale` when its pinned assembly hash differs from the
current manifest. Replacing an existing contract requires `expectedHash`; same content
is idempotent.

## Gate vs execute

- `pearl_run({})` is the read-only gate. It plans the selected template against the
  project budget, observes the six pearls from existing evidence, and returns
  `status` + localized failures. A missing `pearl-profile.json` blocks.
- `pearl_run({execute:true, inputs})` dispatches the template steps through the same
  tool registry. `inputs` fills bindings that cannot be derived from project artifacts
  (`gap`, `motion`, `contract`, `versionId`, `claims`, ...).

No profile → no gate; `preflight` lists the pearl step as `notCovered`, never green.

## Step inputs

Each step may have literal `args` and `bind`:

```json
{
  "id": "interfaces",
  "tool": "check_assembly",
  "bind": { "manifestPath": { "from": "project", "path": "assembly.path" } }
}
```

`from` is `project` / `input` / `step` / `contract` / `failure`. A missing value is
`MissingStepInput`; the executor does not guess. `assembly.parts` is built from the
manifest with part id, version, translate and rotate.

## Tool success is not geometric success

A successful tool call can still return:

```json
{ "judgement": "excluded", "overallStatus": "fail" }
```

That is a step failure. `semanticFailure` checks `judgement=excluded`,
`overallStatus=fail`, and explicit `ok/pass/passed=false`. `judgement=difficult`
is NOT a failure, but it sets `explanationRequired`: the reply must explain what
was difficult and why it is acceptable (or not). Silence is not an explanation.

## Budget and stopping

- One template execution has one `maxCostSeconds` deadline.
- Each tool keeps its own `timeoutMs`; missing entries fall back to 120s, long tools
  are named explicitly.
- A step that is slow but not over its timeout is logged, not killed and not downgraded.
- `transient` retries the same input at most twice.
- `repair` does not mean "retry twice": the same failure signature repeating is
  `no-progress` and stops; the whole necklace is capped at four repair rounds.
- The executor returns `on_fail` route and `next`; it does **not** edit geometry.
  Geometry repair is an LLM/agent action; a geometry solver would be a different product, not this plugin's guarantee.
- `runTemplateRepairLoop` reruns only after a caller-supplied repair returns true;
  every round is persisted in `assembly/pearl-repair-history.json`; no-progress
  and the total deadline stop it.

## Output and attention

| status | output |
|---|---|
| `pass` | one line: `pearl: pass · N step(s)`; do not dump evidence |
| `warn` / `repair-needed` | compact `! code @ where` list + `next` |
| `difficult` | not a fail, but `⚠ explanation required` + what/where; the LLM must explain |
| `fail` / `blocked` | loud: `what / why / where / next` for each failure |

`difficult` and `fail` are attention guides. A silent `difficult` is a bug in the
reply, not a pass.

## Explained undeclared contacts

A rule pack may declare `undeclaredExplanations` (`{a,b,reason}`). The fit
observer removes those pairs from `counts.undeclared`, but keeps an
`explained-undeclared` info finding with the reason. Only **unexplained** pairs
are subject to `undeclaredPolicy:block`. Silence is not an explanation.

## Probe templates (catalog, not default)

A probe is a `checker/v1` package (manifest + entry + negative samples), not a
normal CAD tool. `pearls/probe-templates/fit-clearance/` is an implemented
template: it compares a declared measured clearance to a declared minimum and
ships a negative sample. It is in the catalog, but **not mounted by default**.
A profile selects it explicitly:

```json
{ "probe": "fit-clearance", "probeConfig": { "minClearanceMm": 1, "measuredMm": 0.2 } }
```

`mountProbe` still checks `pearl.probe.allowed`, version, pearl ownership and
negative samples; `pearl_run` reports `probe.report` and blocks on fail/error.

This is feasible, but:

- no arbitrary code injection: the LLM selects an id, it does not paste a binary;
- one probe per pearl (`maxProbe: 1`);
- a template without a negative sample is not mountable;
- a prebuilt probe is not a substitute for the pearl's own evidence.

## Simulation: two classes

- **Consistency / feasibility**: no user target; default checks such as assembly interference,
motion clearance, static stability, printability. These can be gates inside `fit`/`make`.
- **Functional target**: requires a declared scenario and target (e.g. "5g at 100mm tips
the balance by >=2 deg"). It is a `deliver` claim witness, not a default gate; without a
scenario/target it is `unobserved`/`not-applicable`, never pass.

`fit/mechanism` already uses `simulate_motion` for consistency. The missing pieces are a
`brief` acceptance/scenario contract and a `deliver` functional template that runs
`simulate_*` and compares the metric to the target.

## What this is not

This is not a geometry repair engine. It does not choose a new position, size, datum
or joint. The LLM/agent owns those decisions; the plugin finds, localizes, witnesses,
and re-checks after the change. A repair loop is only orchestration around that.

## Deeper material

`dsh-cad-harness/docs/PEARL-PLAN.md` (milestones, evidence, gaps) and
`docs/DECISION-LOG.md` (why the two contracts / one deadline / no-progress policy).
