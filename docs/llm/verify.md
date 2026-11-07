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

# register a check before drawing (the only writer of checks/registry.json)
node scripts/check-register.mjs /path/to/project --id fit-clearance
node scripts/check-register.mjs /path/to/project --all
node scripts/check-register.mjs /path/to/project --unregister fit-clearance
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

## Custom checks (V1.2, opt-in)

A project can bring its own `checker/v1` check for a criterion the built-in checks
cannot express (a functional target, a project-specific threshold). A check is
**evidence for one of the six rows**, not a workflow step. It is off unless
`--checks` (or `--checks-dir`) is given.

```text
<project>/checks/
  registry.json          <- registration record; verify reads it, never writes
  <id>/
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

**Pre-registration.** A check is evidence only after it is in
`checks/registry.json`. Registration is an explicit act, not a discovery:

```bash
node scripts/check-register.mjs <project> --id <id>
node scripts/check-register.mjs <project> --all
node scripts/check-register.mjs <project> --unregister <id> [--reason <text>]
```

The command validates the manifest/permissions/entry, runs the negative sample,
hashes the **whole check package** (manifest + code + fixtures + measurements),
and writes `{id, version, hash, row, criteria, registeredAt}`. It refuses a
package whose negative sample passes, and refuses to replace a different hash
without `--supersede` (or a prior `--unregister`). `verify` is read-only.

Registry state decides whether a check runs:

| state | condition | behavior |
|---|---|---|
| `registered` | hash and version match | run |
| `unregistered` | no active entry | **not executed**; `check-unregistered`; claim blocked |
| `modified` | hash/version/row/criteria differ | **not executed**; `check-modified`; claim blocked |
| `late` | `registeredAt` > latest current version | run, but **advisory only**; claim `claim-check-late` blocked |

To fix a check after seeing the result: `--unregister`, edit, `--register`. The
new registration is `late` for the current version, so it cannot witness a claim;
to restore a valid witness, register the fix and then create a **new version**
after it. Re-registering the same hash keeps its first `registeredAt`; it does not
reset the clock. `--supersede` is the explicit one-step alternative to
`--unregister` + `--register`; the old entry goes to `history`.

**Trust gate.** Registration runs the negative sample; every check must have at
least one, and it must **not** return `pass`. A package that passes its own bad
fixture is refused. `verify` does not execute an unregistered or modified package
at all. Missing fixture, timeout, malformed JSON or a non-zero exit is an error,
never a pass.

**Output contract.** One JSON document on stdout; logs go to stderr. The report
must account for **every declared criterion**:

- each `criteria[]` entry must appear in a `findings[].criterion` or a
  `coverage.skipped[].criterion`;
- `coverage.criteria` must be a subset of the declared criteria;
- every finding criterion must be listed in `coverage.criteria`;
- `status=pass` requires a **pass finding for every criterion**, `complete:true`,
  and no skipped criteria;
- `status=blocked` requires a blocked finding or a skipped criterion;
- `status=fail` requires at least one fail finding;
- every `skipped[]` item is `{criterion, reason}` with a non-empty reason;
- `artifacts` must be empty; `findings` ≤ 50;
- `entry` is exactly `["node", "<file>.mjs"]` — no `-e`, flags or shell.

**Side-effect guard.** The check runs from a temporary copy of its directory.
The project is stat-snapshotted before and after; a write to `assembly/`,
`cad-data/`, `claims.json`, `checks/` or any other project file yields
`check-mutated`, and the check's evidence is **discarded**. Scratch writes inside
the temp cwd are allowed. This is a best-effort guard, not a sandbox: reads and
network outside the project are not prevented.

**Mapping.** A check's findings are attached to its `row`:

| check result | default | with policy `blockOn: ["custom-check"]` |
|---|---|---|
| `pass` + complete coverage | `check-passed` info | still info (a pass is not promoted) |
| `fail` | `check-failed` warn | blocked |
| `blocked` / `error` | `check-blocked` / `check-error` warn | blocked |
| incomplete coverage | `check-incomplete` warn | blocked |
| invalid manifest/negative | `check-invalid` warn | blocked |
| writes the project | `check-mutated` warn | blocked |
| unregistered / modified | `check-unregistered` / `check-modified` warn | blocked |
| late registration | `check-late` info (result stays advisory) | info |

The report adds `checks[]` (`id/version/hash/row/status/findingIds`, plus
`registeredAt`/`late`) and `coverage.checked` gets `check:<id>@<version>`. `--mount-checks` validates and
records the check but does not run geometry: `checks[].status = "pending"` and
`coverage.missing` names it. Mount is **not** a pass.

**Claim link.** A claim can name a check as its witness:

```json
{ "kind": "fit", "statement": "clearance >= 0.8 mm", "checkId": "fit-clearance" }
```

`checkId` wins over `runId`; the check must be **registered and not late**,
mounted (`verify --checks`), pass, cover every criterion, and cite the current
version set. A claim whose check is missing/unregistered/modified/pending/late/
invalid/failed/error/mutated is blocked. The delivery audit does not also judge a
`checkId` claim by run kind.

**Boundaries.** V1.2 runs **Node** checks only, requires
`["node", "<file>.mjs"]`, rejects `write:artifacts` and non-empty `artifacts`,
caps `timeoutMs` at 30s, `findings` at 50, and the check package at 500 files /
10 MB. It is **not a sandbox**: the check runs with your privileges; the runner
bounds time/output/env (temp HOME/TMPDIR) and the project snapshot catches writes,
but reads/network outside the project are not prevented. `registeredAt` is a
declaration, not a notarised timestamp: the registry makes the normal path
explicit and changes visible, but a determined editor can still forge it.
Mounting a check means trusting its author. `examples/checks/fit-clearance/` is a
working template; run `check-register` after copying it.

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
