# Standard-parts catalogue: what `library/` is, and what works today

[中文](../../llm/library.md) | English

> Long-form reference; short rules live in `skills/cad-toolbox/SKILL.md`.

Short version: **99 pre-generated standard parts ship in the package, but 0.1.2-preview.2 has
no first-class tool entry for them.** Do not confuse the catalogue with BOSL2 or the spring
`standardId` used by assembly checks.

## Three different things

| Name | What it is | Where | How to use it today |
|---|---|---|---|
| **Standard-parts catalogue v0** | 99 specs / 14 families, pre-generated STEP/STL, `fit` / `visual` LODs | `library/catalog.json`, `library/parts/<id>/` | Ships with the package; **no `cad_part` list/get/import-by-catalog action** (below) |
| **BOSL2** | Optional **OpenSCAD-only** modelling library (threads, gears, screws, walls, bearings) | User downloads into `lib/BOSL2/`; not shipped | `include <BOSL2/...>` inside `scadCode` only |
| **Spring `standardId`** | One seed entry (pen spring) for assembly checks | `src/host/standard-parts.ts` | `spring-behaviour` in `cad_assembly` (`action: "check"`) fills fields from it |

“Standard part” is overloaded across these three; always name which one you mean.

## Catalogue contents

- `library/catalog.json`: 99 specs, 14 families, `package` (all currently `core`),
  `frequency.source: "assumed"`, LOD paths + SHA-256, and each family's
  `fitRule` / `visualRule` / datums.
- `library/parts/<id>/part.json`: the spec's datums, bbox, volume, generator and dimension source.
- `library/parts/<id>/fit/model.{step,stl}`: the assembly/contract representation.
- `library/parts/<id>/visual/model.{step,stl}`: display only; 55 specs use `alias-fit` and reuse fit files.
- IDs are stable, e.g. `iso4762.M5x16`; **do not put the `core/` package prefix in the ID**.

`library/README.md` has the full file count, family coverage and regeneration/validation
instructions. `accept-library-catalog` checks 99/14, IDs, hashes, aliases, visual bbox and file
counts; it currently runs only in the aggregate `npm run accept`, not in
`accept:preview` / the release gate.

## fit vs visual

- **fit is the contract/assembly representation**: nominal dimensions, no helical threads,
  bearing balls or real spring coils; visual is display only.
- **visual is not a checking input**: assembly, collision, measurement and delivery use fit
  (or a version imported from it).
- **visual bbox must stay inside the fit envelope**; the generator fails otherwise.
- `library/README.md` says “LOD is chosen by the agent at use time”; that is a design target,
  not a capability of this release.

## What an agent can do today

The production surface has 9 surfaces / 39 ops; `cad_part` is:

```text
create · generate · import · merge · role · appearance
```

There is no `library` / `catalog` / `standardPart` action, no `libRef` field and no
`library.lock`. Therefore:

- **Do not claim** you can “list the catalogue” or “pick fit/visual by ID”; no such tool exists.
- If the user explicitly supplies a `library/parts/.../fit/model.step` path, import it with
  `cad_part` (`action: "import"`) as a `stock` version; that is ordinary import, not catalogue
  selection.
- If the user only says “use an M5 bolt”, there is no discoverable catalogue entry; state that
  the catalogue is not tool-exposed in 0.1.2-preview.2, or ask for a STEP/STL.
- Use **BOSL2** for threads/gears; that is OpenSCAD modelling, not a pre-generated catalogue part.

`assembly.json`'s `stockRef` is free text, not a catalogue resolver; `elastic.standardId` only
accepts the spring seed, and unknown IDs are rejected by schema/validation.

## Future interface (not implemented; do not call it)

If it lands, the minimal contract should be:

```text
cad_part({ action: "library", args: {
  op: "list" | "get" | "import",
  specId?: "iso4762.M5x16",
  lod?: "fit" | "visual",
  package?: "core" | "full"
}})
```

- `import` returns a `versionId` and uses the existing version/render/assembly paths;
- the manifest gets a structured `libraryRef` (`specId` + `lod` + `catalogVersion`/hash)
  instead of free-text only;
- `visual` must never enter a contract/check;
- `accept-library-catalog` enters preview/release, plus a list → import fit → assembly datum
  → check end-to-end test.

Until then, this document describes the present state, not a callable API.
