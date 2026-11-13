[中文](../../llm/delivery.md) | English

# Delivery discipline: claims, evidence and coverage

> Long-form reference; short rules live in `skills/cad-toolbox/SKILL.md`.


## Delivery discipline (non-negotiable, learned the hard way)

1. **Never deliver on green numbers alone.** Before you tell the user a design
   is done, LOOK at the final state: the assembly renders (validate_assembly
   attaches them), the panel screenshots, or a fresh render_part of the risky
   part. Two microscope deliveries were “all green, obviously fake in the image” because they skipped this step.
2. **Run `check_printability` on every part before declaring the design done**,
   and again after any edit that changes a wall, a boss or an angle. A part can
   be geometrically valid, watertight, interference-free — and still 0.5mm thin
   in a place no number you checked looked at. `verdict: check` means the
   findings get answered (fixed or argued), not ignored.
3. "It compiles / it assembles / the report passes" are three different claims.
   Delivery requires all three PLUS eyes on the shape and a printability pass.
4. **A part version update invalidates every whole-machine result that names the
   old version.** Merged rigid bodies (`merge_parts`), `simulate_physics` /
   `simulate_motion` / `validate_assembly` runs, and `check_assembly` reports are
   all **pinned to a specific version** (run `sourceVersionIds`, manifest node
   `version`, interface `params.runId`). After a part becomes `vNNN+1`, old
   results do not follow — they still say “exists, green, passed”, but describe
   **geometry that no longer exists**. Before delivery:
   - rerun every whole-machine artifact (merged body, physics/motion simulation,
     assembly validation), or state explicitly which version it is based on and
     why it is still valid;
   - update manifest nodes/interfaces that point at the old version, then rerun
     `check_assembly` (a run citing a superseded run reports `SUPERSEDED`);
   - never cite an old green run as evidence for the current version — **evidence
     expires with the version it cites**. Test: before saying “passed”, ask
     “which version did it verify?”

5. **A whole-machine claim must be backed by a whole-machine run.** A physics or
   assembly conclusion covers the parts that were IN that run and no more:
   microscope5's delivered “whole machine” evidence included seven single-part physics
   runs, while the 16-part assembly never once passed. Before saying “the whole machine”, check the run's part list — if it is not the full delivered
   set, the claim is about a fragment, and you say so or you re-run it over
   everything.
6. **A mechanism must be able to fail the contract.** If parts move relative to
   each other (gear/rack, slide, hinge, cam), the manifest declares revolute /
   prismatic interfaces with `check: "motion-clearance"` citing a motion run.
   **Procedure before you call a contract green:** list every interface, take the
   ones whose `type` is a joint, and for each ask (a) which operator its `check`
   uses, (b) whether that operator consumes a run, and (c) whether the run it
   cites covers the versions you are delivering. Any joint whose answers are not
   (motion-clearance, yes, yes) is unverified no matter what the report says —
   "N interfaces, 0 hard violations" cannot speak about a mechanism the contract
   cannot fail on.

   A motion run now stores its **input** beside the result: `runs/<id>/motion-spec.json`
   holds parts (version or inline code), placement, joints, drive and cycles. Replay it on
   newer versions with `node scripts/replay-motion.mjs <project> <runId> --set part=vNNN`;
   that is a normal `simulate_motion` call and writes a new run. Runs older than this have
   no spec and `verify` reports them as `motion-not-replayable` — for those, re-running
   still means rebuilding the mechanism by hand.
7. **Run `delivery_audit` before any delivery claim, and answer its findings.**
   It reads the corpus (not your memory) and returns: failing runs that are
   still newest of their kind, stale evidence (`stale-evidence`), versions nobody
   checked (`versions-never-cited`, `newest-version-unvalidated`), contract gaps
   (`contract-without-motion`, `contract-stale-nodes`), **merged bodies built from
   versions a part has since replaced** (`merged-stale`), repeated runs
   (`duplicate-runs`), and mesh files no version accounts for
   (`unregistered-geometry`). A
   verdict of `excluded` (or any `blocked`-severity finding) means the corpus
   contradicts the claim — fix it, or state the exception explicitly to the user. Citing a green number that the audit
   flags as stale is exactly the failure this step exists to prevent.
8. **Start the delivery round with the read-only plan, not with a tool hunt.**
   `deliver` derives a plan from the BOM/ICD, parts roles, claims and the run
   graph. Each row names the target, the check, the witness (run/check), where to
   look and the atomic tool call that would fill a gap. It runs no CAD and writes
   no run. `planVerdict` is scoped to the process you pass (or the per-part
   `process`); `corpusVerdict` is the audit. When they differ, the plan says so —
   usually the audit is counting a run under a process the plan does not claim.
   Missing process/profile/run is `unobserved` with the declaration or call that
   fills it, never a pass. **Process is decided in at most three key-node choices,
   not per part:** (1) the BOM `manufacturing` policy — a user-approved allowed
   set (`allowed` + `approvedBy`), (2) the `M:mix` summary of the printed parts
   (confirm the mix once, then record `mixApprovedBy`), (3) exceptions for parts
   outside the set. The agent
   assigns each part from the allowed set (`source: "policy"`); only an outside
   choice needs one user decision. A per-part confirmation loop is a design
   failure, not a rigorous workflow. An unconfirmed policy/recommendation is
   `unobserved`, and the plan asks **once**. **A plan pass is not a claim:** run
   the named tools, then `verify` / `delivery_audit`.
