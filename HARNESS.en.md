# Yingzao (营造): positioning and philosophy

[中文](HARNESS.md) | English

**Version**: v2.5 (2026-11-28)
**History**: v2.5 adds §6.2 “The skill is a map, not an inspector”, §11.18 “Gates in tools, maps in skills”, and §11.19 “Design for laziness” — moving mandatory process from skills to tool preconditions and stating that on-demand skills are not a process-enforcement layer. v2.4 (2026-11-13) set the brand to **Yingzao (营造)** and the preset display name to “Yingzao mode”; technical ids are unchanged. v2.3 adds §6.1 “The venue is not the product: factory, utilities, QA, materials” and §11.17 “Venue before product” — support is tiered, no promise of zero product gaps, and QA inspects deliverables without judging creative quality; §7's “fill the gaps” is narrowed to “fill gaps in the core loop; non-core capabilities may be declared boundaries”. v2.2 (2026-10-23) added §11.15 and §11.16, both disciplines earned from case law. v2.1 (2026-10-19) added §11.14.

**Status**: `DESIGN.md` records the **current design**; `docs/DECISION-LOG.md` records the **history of choices**. When either disagrees with the **positioning statements here**, this file wins.
**Admission test**: this file only holds a statement if it still holds after removing proper nouns, paths and numbers. If not, it does not belong here (see DECISION-LOG 2026-10-16 for the split).

---

## 1. Evolution of positioning

```
toy (the former ToyMarker)
  → immature productivity tool (after LLM modelling exceeded expectations)
  → open CAD harness (since 2026-09-27: no longer an internal tool)
```

- The name is an origin, not the positioning. On 2026-11-12 the brand became **Yingzao (营造)**; technical ids do not follow the brand yet.
- The premise of opening up: **stabilise the boundary document and the protocol first**, philosophy first, refine in use.
- Ambition has a right and a wrong implementation: **a closed loop becomes a harness; piling on features becomes the 12,006th CAD plugin.**

## 2. The core proposition: what a CAD harness is

**By exclusion**: it is not a stronger CAD program. It does not compete on feature count, solver precision or SolidWorks parity.

**By positive statement**:

> The LLM can already write OpenSCAD. Geometry generation has never been the bottleneck; **the bottleneck is not knowing whether the result is right**. A system that generates but cannot verify produces “looks right” — obvious in a toy, fatal in production.

> **A CAD harness = infrastructure that makes LLM-generated geometry verifiable, iterable and deliverable.**
> It is not a geometry generator; it is **the loop between generation and truth**.

**Four pillars + memory** (all infrastructure elements, not a feature list):

| Pillar | Content |
|---|---|
| Truth engine | boolean intersection / measurement family / datum declarations (engines and algorithms in DESIGN) |
| Layered verification | L0 static geometry and assembly / L1 rigid body and mechanism / L2 continuum / process feasibility (wall thickness, overhang, draft, 2D cutting, turning, CNC, EDM — the decidable subset) |
| Two visual channels | renders and frame data for the LLM; panel replay and annotation for the human |
| Human channel | sessions / three initiation paths / screenshot annotation / version review |
| Memory | version graph + manifest (intent, parent, status) |

**Evidence**: a scan of 12,005 plugins concluded that **viewing is a commodity; the closed loop is the moat** (zero overlap in the loop domain).

**One level deeper — the real asset is the protocol, not the plugin**: “the model emits intent/references; the geometry engine resolves truth” is a **protocol statement, independent of OpenSCAD**. Done well, it can be implemented by any geometry kernel and consumed by any agent. That is the full meaning of “a harness for CAD”: **the standard interface between LLMs and the geometry world** (analogous to LSP for editors and MCP for tools). The current plugin is only the first implementation of that protocol.

## 3. Designers in the LLM era: replace / augment / irreducible

**Three questions** (not “can an LLM do it?”): ① Where does intent come from? A tool can answer “how”, never “what”. ② Is there an objective test of correctness? What has a test can close the loop; what is judged by a human cannot be replaced. ③ Who bears the consequence? Responsibility cannot be delegated to something that bears no consequence.

- **Replaceable: operator functions.** The signature is explicit intent + verifiable result + mechanical execution (modelling, standard parts, iterative labour, unit conversion and naming, learning the software itself). The choice is explicit: **operating interfaces were designed for human hands; the LLM's hands are text** — code CAD is a learning cost for humans and a native language for LLMs.
- **Augmentable: inspector functions.** What a human should do but cannot afford (too expensive, too slow, too expert) can now run every round. What is augmented is not only efficiency but **the timing of verification** — from “one acceptance at the end” to “askable throughout”. But **judgement is not replaceable**: whether a 0.75 mm gap is mating intent or a defect is known only to the human; the tool reports truth, the human judges good.
- **Irreducible: designer functions.** Source of intent, value trade-offs (every choice is a value judgement), tacit constraints (overhang angle, finger thickness, customer preference), taste and acceptance, responsibility and sign-off, the final check against the physical world.

**Current evidence**: the three-layer division in acceptance runs (script assertions for hard numbers → model reads images → human re-checks) is structurally identical to this classification — **machines check what is checkable, LLMs read what is describable, humans keep what cannot be delegated.**
**Watch for the backfire of over-replacement**: if the human never touches geometry, their mental model thins, acceptance degrades into a rubber stamp, and augmentation fails. The human channel must stay a **cheap way to interrogate**.

## 4. The human channel: do / see / point / say / judge

| Verb | In the LLM era | Plugin surface |
|---|---|---|
| **do** | hand over | generation / compile / simulation tools |
| **see** | both directions (the LLM sees renders, the human sees panel replay) | product browser: version geometry + run replay (presented by what the artifact is) |
| **point** | **must remain; the human's core gesture** | annotation boxes, two-point measurement in the panel, pause-and-point in replay |
| **say** | natural language + clarification dialogue | conversation |
| **judge** | **must remain; the human's core authority** | approve / revert / three initiation paths |

**Overall principle**: **the human points at WHAT, the engine computes WHERE, truth travels with the artifact.**

Three judgements this document must hold (implementation discipline in DESIGN §30): **the artifact is the subject, not a mode switch** (the human chooses only the artifact; presentation follows what it is); **zero noise ≠ zero notice** (noise may be silenced; **missing capability must be said**); **part identity is declared, not inferred** (part = version store, version = immutable commit, run = CI result).

## 5. Philosophy by milestone

| Milestone | Positioning | One-line philosophy |
|---|---|---|
| M1 visual loop | replace the modelling operator | intent in, code out, engine truth, LLM self-review; the human's first intervention is acceptance, not operation |
| M2 assembly verification | augment the inspector | verification moves from a one-off final action to on-demand throughout; reading can be automated, judgement stays with whether the gap is deliberate |
| M3 rigid physics | augment the inspector | move “you only know after printing” before printing; mm units throughout = the human needs no translation |
| M3.6 mechanism motion | augment + explicit assembly semantics | a joint declaration is the first explicit model of assembly intent; negative-sample acceptance = the verifier is trustworthy |
| M4 fluid | augment (democratise) | trend judgement for people who cannot afford CFD; the subject's physical state chooses the engine |
| M4R venue | philosophical turn | the LLM is an engineer with a venue, not a form filler; the plugin is the venue and the stand, not the contractor |
| M5 analysis | interpretation belongs to the LLM | the plugin does not overstep into interpretation |

## 6. Three layers of capability openness (against over-correction)

> **The venue idea opposes narrowing capability (contractor), not labelling it (guide).**

| Channel | Consumed when | Answers |
|---|---|---|
| JSDoc / source | when the LLM reads code | the precise behaviour of a function |
| examples/ | before the LLM acts | a complete, runnable shape |
| **skill** | **loaded on demand at task start** | **what is in the venue? which route does my problem take?** |

Facing tens of thousands of lines, the LLM first needs a **map** — an LLM that does not know a module exists will not read its JSDoc.

**Test**: a good skill is one where deleting it still lets the LLM reach the same result from source, only slower (a guidebook); a fake-API skill is one where deleting it removes capability (capability was locked into a narrow interface and should be split out). A skill may only describe existing capability, pass on decision experience and point out traps; it **must not** replace real library functions, freeze scene semantics, or turn judgements the LLM should make into rules.
**Full statement**: **the library provides capability, the runtime provides execution, the skill provides the map — all three are part of the venue.**

### 6.1 The venue is not the product: factory, utilities, QA, materials

> **We are not a product company; we are a venue.** Product thinking asks “what did we ship, what is missing, what do competitors have?” Venue thinking asks “what can be done here, are water/electricity/roads connected, who inspects the output, where do materials come from?” The two sets of questions lead to different roadmaps: the first treats gaps as product debt, the second treats them as the venue's current conditions.

- **Factory**: the plugin is the factory, not the product. A factory does not decide what the user produces; it guarantees space, rules and safety boundaries; users can make things we did not think of.
- **Utilities**: water (runtime/dependencies), electricity (geometry and verification engines), roads (conversation/tool/artifact paths). Utilities are the venue's obligation; a blocked path must be **stated** (§11.7 zero noise ≠ zero notice), not left for the user to guess.
- **QA**: we inspect **deliverables**, by deliverable type — geometry/printability goes through watertightness, wall thickness, interference, printability and data consistency; renders get the minimum check “the image comes out and its parameters are traceable”. **We do not judge whether the user's creative work is good.** The QA report is issued by the venue, not a product certificate; an artistic render does not automatically mean a printable part.
- **Materials**: users may request materials from us (templates, examples, standard parts, baseline scripts) or bring their own (geometry, scripts, third-party libraries). The venue does not force a material source; it only requires that materials can enter and be verified.
- **Entry point**: trajectories computed by external scripts enter through `dsh-cad-import-run`, using the same writer/lock/index as the tools, recorded as `check` by default (the venue did not witness the computation). The correct response to “the tool cannot do this” is to compute with a script and import, not to change plugin source.
- **Incubator / industrial park**: we are a creative incubator and a design park, not a factory delivering one specific product. We provide the conditions for ideas to be verified, iterated and handed over; the final product is defined and owned by the user.
- **Tiered support, not universal**: some routes get tiered support — skill maps, install preflight, baselines, acceptance, examples; but not “all platforms, all scenarios, all results are guaranteed”. The level of support is the venue's investment choice, not a product promise. Blender bpy was tried as an art lane on 2026-10-25 and removed for workflow mismatch (DECISION-LOG 2026-10-25).
- **No promise of zero product gaps**: we do not aim at a complete feature table and do not promise there are no gaps; we promise the venue's utilities, QA and stated support level. What is missing and which path is blocked are stated with alternatives; whether to fill a gap is judged by real tasks and the venue's return on investment, not by “the competitor has it, so we must too”.
- **Product gaps are not this project's unit of measurement**; we measure “venue usability” and “level of support”.

### 6.2 The skill is a map, not an inspector

A skill's job is **to point the way**: what the venue offers, which route this problem takes, why, and where the traps are. It is loaded on demand at task start as a context-economy choice; it is **neither guaranteed to load nor a process-enforcement layer**. A “you must do X first” rule that lives only in a skill hands a mandatory step to the model's discretion; if the model does not load it, does not read it, or judges it unnecessary, the process is skipped — that is a division-of-responsibility error, not disobedience.

**Test**: delete the skill; the flow must still be impossible to skip (the tool refuses, acts automatically, or leaves an unfinished state). If deleting the skill loses the flow, the flow was described, not implemented.

Therefore:

- **Mandatory** = a tool precondition, state machine or gate; the skill only explains why and where to look next.
- Every checklist item in a skill must map to an existing refusal or automatic action; an item without one is a hint, not a rule.
- A tool's error must name the executable next step (which action, which field), not hand the process judgement back to the reader.
- When skill and tool disagree, the tool's actual behaviour wins; documentation follows the tool, not the reverse.

In one line: **the skill answers “which path”, the tool answers “was this step done and what is missing”, and the gate answers “may this ship”.**

## 7. Gaps and boundaries: toy → productivity tool

**Rule: fill gaps in the core loop; non-core capabilities may be declared boundaries with clean handoffs.** Treating a boundary as a gap is scope creep; treating a gap as a boundary keeps it a toy forever.

| Dimension | Toy | Productivity | Verdict |
|---|---|---|---|
| Criterion | looks right | numbers right + process-feasible + reproducible | gap |
| Failure | retry on error | predictable failure + explicit boundary | gap |
| Delivery | a file comes out | deliverable, handoff-ready | gap (interop formats in DESIGN) |
| Interop | none | design on existing parts | gap (external geometry as first-class versions) |
| Scale | one part | assembly | gap (representation, see §8) |
| Human | request + look | precise edit + sign-off + traceability | gap (authoritative edit) |
| Accuracy | trend | hand off to certified tools when needed | **boundary** (make the handoff contract, do not fill) |
| Kernel | CSG mesh | B-rep + constraint solver | **boundary** (pluggable, not self-built) |

**Attribution discipline (a lesson bought with cost)**: merging two different gaps into one row lets an unrelated problem block one of them for months — **misattribution is itself a gap**. First ask “is the missing thing the capability itself, or the link that connects an existing capability?” Which gaps are filled and which remain boundaries is in DESIGN.

**How to read this from the venue view**: the “gaps” here are gaps in **venue capability**, not in a product feature table; whether to fill one is judged by §6.1 and §11.17 — by real tasks and the venue's return on investment, not because “a product should be complete”.

## 8. Assembly representation: the codebase analogy

**Original stance (abandoned)**: “5/20/50 parts need completely different representations; fix the scale first, then the representation” — treating scale as a gate.
**Revised stance**: a harness for a large codebase can edit hundreds of thousands of lines; an assembly can in principle do the same. **The key is not a size gate but expression** — the answer is not “fit the whole assembly into context” but **a representation and tools that make a large assembly navigable**.

**The drawing equivalent of a large assembly = a list of executable interface contracts (BOM + executable ICD)**, both halves in one artifact:

- **BOM**: which parts exist, how many instances, what type — **type and instance are separate** (20 screws = 1 type, 20 instances), like package management in a codebase.
- **Executable ICD**: who mates with whom, what type, nominal value, tolerance. **“Executable” is the key** — it is not a table for humans but a contract the engine checks item by item; a mismatched mate type should surface **like a compile error** during validation, not be left for a human to compare drawings.
- **Fallback beyond declarations**: on every validation the engine reports, in reverse, “pairs closer than the threshold that appear in no interface entry” — **declarations cover intent, discovery catches omissions**. This is a channel traditional ICDs do not have.

**Test**: from “how many parts fit in context” to — **can a new session correctly modify one part of a 50-part assembly using only local views + queries?** Human engineers never hold the whole machine in their heads; they read drawings. The equivalent of the drawing is this representation.

**Positioning**: this is **the necessary first step** (without the representation the assembly line cannot continue), not an optional “do we do it” probe — the experiment only answers whether the expression is correct. The mapping table, items to build and the A0' experiment definition are in DESIGN §31.1. The three assembly gaps are unchanged: semantic loss → contract file; part-level version model → version graph; context overflow → lazy loading + queries.

## 9. Competitive reference: the opponent is a measuring instrument, not an imaginary enemy

- **The lesson of inventing a language**: in the LLM era the core technical question is “what does the model already know” (corpus logic), not “what do you control” (platform logic); using platform tactics to patch a corpus weakness will not spin the flywheel. The right conclusion is **a representation layer on an existing language**, not a new language.
- **What the giants show**: the winning route is also the venue route — no new language, protocol over packaging, riding on real CAD. **This validates the philosophy; it is not a threat.**
- Look quarterly: **is anyone else building a verification loop** (rather than another modelling entrance)? Real competition is the dogfood principle: internal tools die from being unused, not from competitors. **The truth of a gap is judged by real tasks, not by discussion.**

## 10. Opening up

From internal tool to open tool, order matters: ① **boundary document (this file) first** — say what it is and is not before opening; ② **protocol first** — the representation of datum / truth / contract is the first interface to open, before the UI; ③ **examples + skill first** — the minimum open form is “others (and their agents) can use the venue”, not a marketing page; ④ **two fidelity tiers explicitly coexist**: toy tier (fast validation/teaching) and production tier (real delivery), with separate acceptance.

## 11. Principles of choice (the most useful part of this file)

Judgement patterns distilled from past choices; implementation details in DESIGN, case law in DECISION-LOG.

1. **Loop before feature count.** The test for a new capability is “does it make the loop more complete?”, not “does it make the feature table longer?”.
2. **Representation before scale.** Not fitting is not a reason to shrink the problem; it is a reason to build a better representation and query.
3. **The subject's physical state chooses the engine** (the default bias does not retire). Choose the convenient default and write the anti-overreach clause; a continuum problem may not be answered by a discrete solver's output.
4. **Platform wiring and domain runtime are separate.** Host-facing rules stay in the platform language; domain logic goes into the domain runtime.
5. **Three roles do not mix**: machines check what is checkable, LLMs read what is describable, humans keep what cannot be delegated.
6. **The human points at WHAT, the engine computes WHERE, truth travels with the artifact.**
7. **Zero noise ≠ zero notice.** Noise may degrade silently; missing capability must be said. **There is only one criterion**; do not let clients guess the server's decision.
8. **Single authoritative copy.** One fact, one authority; other places hold pointers. One fact with several copies means changing one misses two, and contradictions appear as “both look right”.
9. **Readiness must be falsifiable** (requirements not relaxed; form opened up). Every “done / ready / passed” must name an observation that would prove it wrong; **no completion claim that no observation could refute is acceptable**. Tests, negative samples, measurements with thresholds, counterexamples, “I cannot falsify this because X” are all acceptable forms; “no way to falsify” is not.
10. **Veto and release are asymmetric**: proof is for veto, estimates are for release; threshold judgements must report the margin, and zero/tiny margins are recorded as “difficult”, never passed.
11. **The first criterion for a cost proposal is its impact on the running session**, not how much it saves.
12. **Fix what you learn**: trap → discipline → acceptance criterion; **negative-sample acceptance = the verifier is trustworthy**.
13. **Attribution is part of the conclusion**: write “what I saw” and “what I infer happened” separately; wrong attribution blocks real capability (see §7 and §8).
14. **Attention direction is the tool's output obligation, not the user's discipline.** Every pass/fail must include **suspicious locations** — where, why, which image or coordinate to look at next; a single overall verdict hands the search for defects back to the user. **“I can only see the whole, not the local detail” is forbidden as an excuse for missing a defect**: that is the tool failing to allocate attention, not the user failing to look. Test: hand a pass to someone who has never seen the part; they should know where to look next. If all they get is “looks fine”, the tool is not finished. Conversely, **the plugin is a tool for allocating the attention of humans and agents, not something that consumes attention** — it saves the effort of suspecting everything, not the responsibility to see.

15. **State the coordinate identity only under the conditions where it holds.** For code that transforms geometry or compensates poses, the comment `R(local−p) + (pos+p) = R·local + pos` must state **when it holds** — it holds only when `R·p = p` (identity rotation, or p on the rotation axis); otherwise every copy misleads the next reader. Case law: a motion simulation compensated a rebase with `position + pivot`, placing a toy balance's beam (R = 90° about x, p = [0,84,5]) 119.0 mm from its pin; the kinematic body could not be pulled back and the constraint dragged both pans across the machine — while the report said “drift 0 mm, 0 interferences, pass”. **An acceptance that passes on an identity fixture does not prove this identity.**

16. **Self-correcting solvers hide construction errors: measure the initial state, not only the final state.** Drift, settling and convergence measured at the end show “what the solver has already absorbed”. For any multi-body constrained scene, measure the **initial mismatch** (here, joint anchor distance) **before stepping**; above the threshold, **refuse to run and name the location** — a single number describes only the pose it measured. Case law: the 160.2 mm mid-travel in the previous run was not mechanism travel but the distance a moving part was dragged. Same origin as item 10: **proof is for veto**; initial mismatch is the proof.

17. **Venue before product.** The test for a new capability is not “is the product feature table more complete” but “is the venue more usable, are utilities more connected, is QA more trustworthy, can users bring materials more easily”. Support may be tiered; **no promise of zero product gaps**; whether to fill a gap is judged by real tasks and venue return on investment, not by a competitor's feature table.

18. **Gates in tools, maps in skills.** A mandatory step must be carried by a tool precondition or state machine; a skill only explains and navigates. Test: delete the skill and the flow still cannot be skipped. An on-demand skill is not a process-enforcement layer.

19. **Design for laziness: make the correct path the shortest path.** An agent will skip steps, so never make the correct flow longer than the incorrect one. A new version of an existing part should have its identity, parent version and process prefilled by the tool, with the model supplying only geometry; only a genuinely new part should demand explicit detail. A shortcut must be unique and traceable; on ambiguity, refuse and list the candidates rather than guessing identity.

---

**End.** Positioning-level changes append a version record here; implementation-level changes belong in DESIGN.md; decisions in docs/DECISION-LOG.md; operational facts in README.md.
