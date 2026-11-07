# Custom checks

V1.2 runs opt-in `checker/v1` checks from `<project>/checks/` (or `--checks-dir`).
A check is evidence for one of the six rows, not a workflow step. Register it
before drawing:

```bash
node scripts/check-register.mjs <project> --id <id>
```

| Sample | Language | What it shows |
|---|---|---|
| `fit-clearance/` | Node | manifest + entry + negative sample + `config` + a passing/failing criterion |

`examples/checkers/leg-fit/` is the older Python checker for the deprecated pearl
probe path; V1.1 runs Node checks only.

See `docs/llm/verify.md` for the protocol, the negative-sample gate and the
policy/claim linkage.
