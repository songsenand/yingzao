# Evidence verification (V1)

`verify` is a **read-only evidence report**. It does not run CAD, write runs, write a
contract, or judge the design. It answers: *what evidence is present, fresh, and
witnessed for this project?*

Run it from the harness root:

```bash
node scripts/verify.mjs /path/to/project --advisory
node scripts/verify.mjs /path/to/project --block        # blocking mode
node scripts/verify.mjs /path/to/project --json --out /tmp/evidence.json
node scripts/verify.mjs /path/to/project --checks       # opt-in custom checks
node scripts/verify.mjs /path/to/project --checks --mount-checks  # before drawing
```

The command is also exposed as `npm run verify -- <project-dir> [flags]`.

## Six rows

| row | what it checks | source |
|---|---|---|
| `requirements` | claims/scenario declared and parseable; PROMPT present | `claims.json`, `PROMPT.md` |
| `model` | assembly manifest valid; versions/BOM/datum endpoints resolve | `inspectAssemblyContract` |
| `fit` | interference, interfaces, motion evidence | `observeFit` |
| `make` | printability/thickness; wood cutlist/stock | `observeMake` |
| `review` | top+iso+note review for **printed** parts (role-aware) | `auditDelivery.visual` |
| `delivery` | claims → witness; stale/missing evidence; unregistered geometry | `auditDelivery` + claim checks |

Status is one vocabulary: `pass | warn | fail | blocked | unobserved`.

- `blocked`: evidence missing, stale, or inconsistent.
- `fail`: a design/declared threshold is violated (e.g. printability excluded).
- `warn`: weak evidence, `difficult`, or an explained/exception item.
- `unobserved`: nothing to check, or not run. **Never a pass.**
- A `not-applicable` case is `unobserved` with a reason; it is not a sixth status.

## Claims

A claim is the user's declaration of intent; V1 does not generate it and does not judge
the statement. Default path: `<project>/claims.json`; or pass `--claims <file>`
(relative to the invocation directory).

```json
{
  "schemaVersion": 1,
  "claims": [
    { "kind": "motion", "statement": "the cam drives the slider through 4 mm",
      "runId": "r065", "versionIds": ["v033", "v043", "v049"] }
  ]
}
```

Kinds: `strength`, `motion`, `assembly`, `manufacturability`, `appearance`, `review`.

- With `runId`: the run must exist, have the right kind, and be fresh for the claimed
  versions.
- Without `runId`: V1 checks for a fresh run of the required kind; `manufacturability`
  stays with `delivery_audit` (it needs **every** printed part).
- No claims: the corpus is audited and `requirements` is `warn` ("corpus audit only").
  `--require-claims` makes it `blocked`.

## Freshness

- Assembly-level run (`assembly`, `assembly-check`, `motion`, `physics`, `stress`,
  `appearance`): `sourceVersionIds` must **equal** the current set, and the run must be
  at or after the latest cited version's timestamp.
- Part-level run (`printability`): `sourceVersionIds` must contain the claimed version.
- A run without `sourceVersionIds`, or a version without a timestamp, is **not fresh**
  (blocked; never a silent pass).

## Policy and exceptions (no owner role)

The policy is the user's declaration, not a role. Default: `<project>/evidence-policy.json`;
or `--policy <file>` (relative to the invocation directory). Without a policy, V1 is
**advisory** (exit 0) and still reports the verdict.

```json
{
  "schemaVersion": 1,
  "id": "evidence-policy-v1",
  "mode": "blocking",
  "blockOn": ["evidence-missing", "evidence-stale", "claim-without-witness"],
  "warnOn": ["design-threshold", "difficult", "no-claims-declared"],
  "requireClaims": false,
  "exceptions": "evidence-exceptions.json"
}
```

`blockOn`/`warnOn` use categories (`evidence-missing`, `evidence-stale`,
`claim-without-witness`, `design-threshold`, `difficult`, `no-claims-declared`,
`exception-expired`). The default classifier already maps evidence→blocked,
design thresholds→fail, weak→warn; the policy only overrides.

Exceptions are user records, not approvals:

```json
{
  "schemaVersion": 1,
  "exceptions": [
    { "id": "X1", "finding": "visual-review-missing", "reason": "research body",
      "expiresAt": "2026-12-31", "approvedBy": "song" }
  ]
}
```

A valid exception downgrades the finding to `warn` and records its id; an expired one
leaves the finding blocked and reports `exception-expired`.

## Custom checks (V1.1, opt-in)

A project can bring its own `checker/v1` check for a criterion the built-in checks
cannot express (a functional target, a project-specific threshold). A check is
**evidence for one of the six rows**, not a workflow step. It is off unless
`--checks` (or `--checks-dir`) is given.

```text
<project>/checks/<id>/
  manifest.json
  check.mjs
  negative.json
```

```json
{
  "apiVersion": "checker/v1",
  "id": "balance-tilt",
  "version": "1.0.0",
  "row": "delivery",
  "criteria": ["5g at 100mm tilts >= 2deg"],
  "entry": ["node", "check.mjs"],
  "permissions": ["read:geometry", "read:constraints"],
  "timeoutMs": 5000,
  "negativeSamples": ["negative.json"],
  "config": { "limitDeg": 2 }
}
```

- `row` is one of `requirements/model/fit/make/review/delivery`; it defaults from
  legacy `pearl`, then `delivery`.
- `config` is opaque and reaches the check as `constraints.checkConfig`.
- The runner passes `project.root`, `geometry.parts` (with STL paths), the current
  `versionIds`, and the parsed `claims`.
- The check reads one JSON document on stdin and writes one on stdout; the
  `checker/v1` report shape is the same as the legacy checker protocol.

**Trust gate.** Every mounted check must have at least one negative sample, and
the negative sample must **not** return `pass`. A check that passes its own bad
fixture is `invalid` and is not used as evidence. Missing fixture, timeout,
malformed JSON or a non-zero exit is an error, never a pass.

**Mapping.** A check's findings are attached to its `row`:

| check result | default | with policy `blockOn: ["custom-check"]` |
|---|---|---|
| `pass` + complete coverage | `check-passed` info | still info (a pass is not promoted) |
| `fail` | `check-failed` warn | blocked |
| `blocked` / `error` | `check-blocked` / `check-error` warn | blocked |
| incomplete coverage | `check-incomplete` warn | blocked |
| invalid manifest/negative | `check-invalid` warn | blocked |

The report adds `checks[]` (`id/version/hash/row/status/findingIds`) and
`coverage.checked` gets `check:<id>@<version>`. `--mount-checks` validates and
records the check but does not run geometry: `checks[].status = "pending"` and
`coverage.missing` names it. Mount is **not** a pass.

**Claim link.** A claim can name a check as its witness:

```json
{ "kind": "fit", "statement": "clearance >= 0.8 mm", "checkId": "fit-clearance" }
```

`checkId` wins over `runId`; the check must be mounted (`verify --checks`), pass,
cover every criterion, and cite the current version set. A claim whose check is
missing/pending/invalid/failed/error is blocked. The delivery audit does not also
judge a `checkId` claim by run kind.

**Boundaries.** V1.1 runs **Node** checks only, rejects `write:artifacts`, and
caps `timeoutMs` at 30s. It is **not a sandbox**: the check runs with your
privileges; the runner only bounds time/output/env (temp HOME/TMPDIR). Mounting a
check means trusting its author. `examples/checks/fit-clearance/` is a working
template.

## Exit codes

| mode | codes |
|---|---|
| advisory (default without policy) | 0 (usage/error 3) |
| blocking (`--block` or policy `mode:blocking`) | 0 pass · 1 warn · 2 blocked/fail · 3 usage/error |
| `--strict` | warn also exits 2 |

## What it does not do

- No CAD execution, no recompute, no run writes, no repair.
- No design-quality judgment; thresholds are the project's declaration.
- No CI service, no panel (V1.1), no profile/template DSL, no owner/SLA.
- Custom checks are not a workflow: no `on_fail`, no step bindings, no orchestration.
- The report is a **derived snapshot**; tools never read it back.

## Reading the output

Default text: six rows, then blocked/warn findings (blocked first), then `next`. Use
`--json` for the full report and `--out` for a snapshot. The report's `findings[]` carry
`code / what / why / where / next / witness`; `rows[].missing[]` names the evidence that
would move a row. A row that is `unobserved` is not a pass, even when its cell is quiet.
