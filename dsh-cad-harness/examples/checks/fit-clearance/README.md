# checks/fit-clearance

A `checker/v1` template for a **project-specific** clearance criterion. It is a
sample, not a built-in check: copy it into your project and replace the
measurement.

```bash
mkdir -p <project>/checks
cp -r examples/checks/fit-clearance <project>/checks/
# replace <project>/checks/fit-clearance/measurements.json with a real measurement

# register before drawing (runs the negative sample; writes checks/registry.json)
node scripts/check-register.mjs <project> --id fit-clearance

node scripts/verify.mjs <project> --checks
node scripts/verify.mjs <project> --checks --mount-checks   # before drawing
```

- The check is mounted only after `negative.json` fails; a check that cannot
  reject its own bad fixture is `check-invalid`.
- Results are `warn` by default. Add `"blockOn": ["custom-check"]` to the
  project's `evidence-policy.json` to make it blocking.
- A claim can cite it:

```json
{ "kind": "fit", "statement": "clearance >= 0.8 mm", "checkId": "fit-clearance" }
```

- Changing `measurements.json` changes the check hash: unregister, edit, register.
  Registration after drawing is late: the result is advisory and cannot witness a claim.
- V1.2 is read-only: `write:artifacts` is rejected, `artifacts` must be empty,
  every declared criterion needs a finding, and the check runs from a temp copy
  of its directory. Only Node `.mjs` checks run; `findings` ≤ 50. It is **not a
  sandbox**; the check is your code.
