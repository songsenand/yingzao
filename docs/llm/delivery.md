# 交付纪律：claim、证据与覆盖

> 长解释参考；短规则在 `skills/cad-toolbox/SKILL.md`。


## Delivery discipline (non-negotiable, learned the hard way)

1. **Never deliver on green numbers alone.** Before you tell the user a design
   is done, LOOK at the final state: the assembly renders (validate_assembly
   attaches them), the panel screenshots, or a fresh render_part of the risky
   part. microscope 系列两次"指标全绿、图上一眼假"的交付都是跳过了这一步.
2. **Run `check_printability` on every part before declaring the design done**,
   and again after any edit that changes a wall, a boss or an angle. A part can
   be geometrically valid, watertight, interference-free — and still 0.5mm thin
   in a place no number you checked looked at. `verdict: check` means the
   findings get answered (fixed or argued), not ignored.
3. "It compiles / it assembles / the report passes" are three different claims.
   Delivery requires all three PLUS eyes on the shape and a printability pass.
4. **A part version update invalidates every whole-machine result that names the
   old version.** 整机刚体（`merge_parts`）、`simulate_physics` / `simulate_motion`
   / `validate_assembly` 的运行、以及 `check_assembly` 的报告，全部**钉在具体
   版本号上**（run 的 `sourceVersionIds`、manifest 节点里的 `version`、接口引用的
   `params.runId`）。零件更新出 `vNNN+1` 之后，旧结果不会自动跟着变——它们仍
   显示"存在、绿色、通过"，但描述的是**已经不存在的几何**。交付前必须：
   - 重跑所有整机级产物（合并刚体、物理/运动仿真、装配验证），或在结果里
     显式声明它基于哪个版本、并说明为什么仍然有效；
   - 把 manifest 里指向旧版本的节点/接口更新到新版本，再重跑 `check_assembly`
     （引用已被取代的运行，检查会报 `SUPERSEDED`）；
   - 绝不把"某次旧的绿色运行"当作当前版本的证据——**证据的有效期等于它引用的
     那个版本的有效期**。判据：说"已通过"之前，先问一句"它验证的是哪个版本？"

5. **A whole-machine claim must be backed by a whole-machine run.** A physics or
   assembly conclusion covers the parts that were IN that run and no more:
   microscope5's delivered "整体" evidence included seven single-part physics
   runs, while the 16-part assembly never once passed. Before saying "整机 /
   the machine", check the run's part list — if it is not the full delivered
   set, the claim is about a fragment, and you say so or you re-run it over
   everything.
6. **A mechanism must be able to fail the contract.** If parts move relative to
   each other (gear/rack, slide, hinge, cam), the manifest declares `转动副` /
   `滑动副` interfaces with `check: "motion-clearance"` citing a motion run.
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

