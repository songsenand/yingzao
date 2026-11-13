# Yingzao (营造): positioning and philosophy

[中文](HARNESS.md) | English

**Version**: v2.4 (2026-11-13)
**History**: v2.4 sets the brand to **Yingzao (营造)** and the preset display name to “Yingzao mode”; technical ids are unchanged. v2.3 added §6.1 and §11.17, narrowing “fill the gaps” to the core loop. Earlier history is kept in the Chinese original.

**Status**: `DESIGN.md` records the current design; `DECISION-LOG.md` records decisions. When this file and the others disagree, the **positioning statements here** win.
**Admission test**: this file only holds a statement if it still holds after removing proper nouns, paths and numbers.

---

## 1. Evolution of positioning

```
toy (the former ToyMarker)
  → immature productivity tool (after LLM modelling exceeded expectations)
  → open CAD harness (since 2026-09-27: no longer an internal tool)
```

- The name is an origin, not the positioning. On 2026-11-12 the brand became **Yingzao (营造)**; technical ids do not follow the brand yet.
- Openness requires stable boundaries and protocols first; philosophy first, refine in use.
- Ambition has a right and a wrong implementation: a closed loop becomes a harness; piling on features becomes the 12,006th CAD plugin.

## 2. The core proposition

**By exclusion**: it is not a stronger CAD program. It does not compete on feature count, solver precision or SolidWorks parity.

> The LLM can already write OpenSCAD. Geometry generation is not the bottleneck; **knowing whether the result is right** is. A system that generates but cannot verify produces “looks right” — obvious in a toy, fatal in production.

> **A CAD harness = infrastructure that makes LLM-generated geometry verifiable, iterable and deliverable.** It is not a geometry generator; it is the loop between generation and truth.

**Four pillars + memory**:

| Pillar | Content |
|---|---|
| Truth engine | boolean intersection / measurement family / datum declarations |
| Layered verification | L0 static geometry and assembly / L1 rigid body and mechanism / L2 continuum / process feasibility |
| Two visual channels | renders and frame data for the LLM; panel replay and annotation for the human |
| Human channel | sessions / three initiation paths / screenshot annotation / version review |
| Memory | version graph + manifest (intent, parent, status) |

**The real asset is the protocol, not the plugin**: “the model emits intent/references; the geometry engine resolves truth” is independent of OpenSCAD. It can be implemented by any kernel and consumed by any agent — the “harness for CAD” in the LSP/MCP sense. The plugin is the first implementation.

## 3. The designer in the LLM era: replace / augment / irreducible

Three questions: where does intent come from? Is there an objective correctness test? Who bears the consequence?

- **Replaceable: operator functions** — explicit intent, verifiable result, mechanical execution (modelling, standard parts, iteration, unit conversion, learning the UI). Code CAD is a learning cost for humans and a native language for LLMs.
- **Augmentable: inspector functions** — cheap, frequent checks; verification moves from end-of-line to throughout the loop. **Judgement is not replaceable**: whether a 0.75 mm gap is intent or defect belongs to the human.
- **Irreducible: designer functions** — intent, value trade-offs, tacit constraints, taste, sign-off, final physical check.

**Over-replacement backfires**: if the human never touches geometry, their mental model thins and review becomes a rubber stamp. The human channel must stay cheap to interrogate.

## 4. The human channel: do / see / point / say / judge

| Verb | In the LLM era | Plugin surface |
|---|---|---|
| **do** | hand over | generation / compile / simulation tools |
| **see** | both directions (LLM sees renders, human sees replay) | product browser: version geometry + run replay |
| **point** | **must remain** | annotation boxes, two-point measure, pause-and-point |
| **say** | natural language + clarification | conversation |
| **judge** | **must remain** | approve / revert / three initiation paths |

Principles: **human points at WHAT, engine computes WHERE, truth travels with the artifact.**

Three rules: **the artifact is the subject, not a mode switch**; **zero noise ≠ zero notice** (silence noise, never silence missing capability); **part identity is declared, not inferred** (part = version store, version = immutable commit, run = CI result).

## 5. Philosophy by milestone

| Milestone | Positioning | One-line philosophy |
|---|---|---|
| M1 visual loop | replace the modelling operator | intent in, code out, engine truth, LLM self-review |
| M2 assembly verification | augment the inspector | verification becomes on-demand throughout, not a final gate |
| M3 rigid physics | augment the inspector | move “you only know after printing” before printing |
| M3.6 mechanism motion | augment + explicit assembly semantics | joints are the first explicit model of assembly intent |
| M4 fluid | augment (democratise) | trend judgement for people without CFD |
| M4R venue | philosophical turn | the LLM is an engineer with a venue, not a form filler |
| M5 analysis | interpretation belongs to the LLM | the plugin does not overstep into interpretation |

## 6. Three layers of capability openness

The venue idea opposes **narrowing** capability (contractor), not **labelling** it (guide).

| Channel | Consumed when | Answers |
|---|---|---|
| JSDoc / source | LLM reads code | exact function behaviour |
| examples/ | before acting | a complete runnable shape |
| **skill** | at task start | what is in the venue? which route fits? |

A good skill is a map: deleting it still lets the LLM reach the same result from source, only slower. A fake-API skill removes capability when deleted. Skills describe existing capability, decision experience and traps; they do not replace library functions or freeze scene semantics.

### 6.1 The venue is not the product: factory, utilities, QA, materials

We are not a product company, we are a venue. Product thinking asks “what did we ship, what is missing, what do competitors have?” Venue thinking asks “what can be done here, are utilities connected, who inspects the output, where do materials come from?”

- **Factory**: the plugin is the factory; it does not decide what to produce.
- **Utilities**: runtime/dependencies, geometry/verification engines, conversation/tool/artifact paths. A blocked path must be stated.
- **QA**: inspect deliverables by type; do not judge creative quality.
- **Materials**: users may bring templates, examples, standard parts and third-party libraries; the venue only requires they can enter and be verified.
- **Incubator, not a factory for one product**; support is tiered, not universal.
- **No promise of zero product gaps**; we promise venue utilities, QA and a stated support level.

## 7. Gaps and boundaries: toy → productivity tool

**Rule: fill gaps in the core loop; non-core capabilities may be declared boundaries with clean handoffs.** Treating every boundary as a gap is scope creep; treating every gap as a boundary keeps it a toy forever.

| Dimension | Toy | Productivity | Verdict |
|---|---|---|---|
| Criterion | looks right | numbers right + process-feasible + reproducible | gap |
| Failure | retry on error | predictable failure + boundary | gap |
| Delivery | a file comes out | deliverable, handoff-ready | gap |
| Interop | none | design on existing parts | gap (external geometry as first-class versions) |
| Scale | one part | assembly | gap (representation) |
| Human | request + look | precise edit + sign-off + traceability | gap (authoritative edit) |
| Accuracy | trend | hand off to certified tools when needed | **boundary** |
| Kernel | CSG mesh | B-rep + constraint solver | **boundary** (pluggable, not self-built) |

**Attribution is part of the conclusion**: merging two different gaps into one row can block one for months. Ask whether the missing thing is the capability itself or the link that connects an existing capability.

## 8. Assembly representation: the codebase analogy

The old “define scale before representation” stance is abandoned. The key is not a size gate but **expression**: make a large assembly navigable rather than fitting it into context.

The drawing equivalent of a large assembly is an **executable interface contract list (BOM + executable ICD)** in one artifact:

- **BOM**: types vs instances (20 screws = 1 type, 20 instances).
- **Executable ICD**: who mates with whom, type, nominal, tolerance; checked by the engine like a compile error.
- **Undeclared fallback**: every validation reports near-touching pairs absent from any interface.

**Test**: can a new session modify one part of a 50-part assembly correctly using only local views + queries? Humans never hold the whole machine in their head; they read drawings. This representation is the drawing.

## 9. Competitive reference: the opponent is a measuring instrument

- **The lesson of inventing a language**: the core question is what the model already knows (corpus logic), not what you control (platform logic). Build a representation layer on an existing language.
- **Giants entering**: the winning route is also the venue route — no new language, protocol over packaging, ride on real CAD. This validates the philosophy; it is not a threat.
- Look quarterly for **someone else building a verification loop** (not another modelling entrance). Real competition is the dogfood principle: internal tools die from being unused, not from competitors.

## 10. Opening up

Order matters: ① boundary document first; ② protocol first (datum/truth/contract before UI); ③ examples + skill first (open means others and their agents can use the venue, not a marketing page); ④ two fidelity tiers coexist explicitly — toy tier (fast validation/teaching) and production tier (real delivery), with separate acceptance.

## 11. Principles of choice

1. **Loop before feature count.**
2. **Representation before scale.**
3. **The subject's physical state chooses the engine** (default bias stays); continuous media may not be faked by a discrete solver.
4. **Platform wiring and domain runtime are separate.**
5. **Three roles do not mix**: machines check what is checkable, LLMs read what is describable, humans keep what cannot be delegated.
6. **Human points at WHAT, engine computes WHERE, truth travels with the artifact.**
7. **Zero noise ≠ zero notice.** Noise may degrade silently; missing capability must be said. One criterion, not client-side guessing.
8. **Single authoritative copy.** One fact, one authority; other places hold pointers.
9. **Readiness must be falsifiable.** Every “done / ready / passed” must name an observation that would prove it wrong. “No way to falsify” is not acceptable.
10. **Veto and release are asymmetric**: proof is for veto, estimates are for release; report margins, and call zero/tiny margins “difficult”.
11. **The first cost criterion is impact on the running session**, not how much is saved.
12. **Fix what you learn**: trap → discipline → acceptance criterion; **negative-sample acceptance = the verifier is trustworthy**.
13. **Attribution is part of the conclusion**: separate “what I saw” from “what I infer happened”.
14. **Attention direction is the tool's output obligation, not the user's discipline.** Every pass/fail must name suspicious locations: where, why, which image or coordinate to look at next. “Only the whole can be seen” is not an excuse for missing a defect. A pass handed to someone who has never seen the part should tell them where to look next.
15. **State the coordinate identity only under the conditions where it holds.** For transformed geometry/pose compensation, `R(local−p) + (pos+p) = R·local + pos` holds only when `R·p = p`. A fixture that passes with an identity rotation does not prove the identity.
16. **Self-correcting solvers hide construction errors: measure the initial state, not only the final state.** For constrained multi-body scenes, measure initial mismatch (joint anchor distance) before stepping; above threshold, refuse and name the location. A late-state number describes only that pose.
17. **Venue before product.** The criterion is whether the venue is more usable, utilities more connected, QA more trustworthy, and users better able to bring materials — not whether the feature table is more complete. Support may be tiered; no promise of zero product gaps.

---

**End.** Positioning changes append here; implementation belongs in DESIGN.md; decisions in DECISION-LOG.md; operational facts in README.md.
