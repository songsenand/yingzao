# Mirror directory

The OpenSCAD binaries are **not** in this repository and **not** in the npm
package. They are hosted on a public object store so that users in regions
where `files.openscad.org` is slow do not wait minutes for a 40–85 MB download.

This directory carries the parts a redistributor must publish alongside those
binaries, so the mirror is verifiable rather than an opaque personal bucket:

| File | Why it exists |
|---|---|
| `SOURCE-OFFER.md` | GPL-2.0 §3(b) written offer for the corresponding source |
| `manifest.json` | Per-file SHA-256, size, official URL and mirror URL — generated, never hand-edited |

The GPL-2.0 text itself (`LICENSE.GPL-2.0`) is uploaded **next to the binaries on
the object store, not tracked here**: a second license file inside an Apache-2.0
repository makes automated SPDX detection ambiguous — a scanner finds both
`LICENSE` and a GPL text and cannot decide what the project is licensed under,
which is exactly the failure this directory must not cause. `manifest.json`
still names it because the manifest describes the mirror, not this repository.

## Publishing a snapshot

1. Put the official archives in the mirror directory (same filenames as
   upstream). Do not rebuild or repack them: the pinned SHA-256 must match.
2. `node scripts/build-mirror-manifest.mjs` regenerates `manifest.json` from the
   pinned table in `scripts/provision-lib.mjs`.
3. `node scripts/build-mirror-manifest.mjs --dir <dir-of-archives>` verifies the
   archives against the pinned hashes before you upload them.
4. Upload the archives plus `LICENSE.GPL-2.0`, `SOURCE-OFFER.md` and
   `manifest.json` to the same prefix the code points at. The GPL text is kept
   with the binaries only; take it from <https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt>
   (or the `COPYING` file of any GPL-2.0 project) rather than from this repo.

## Checking a mirror

Anyone can confirm the mirror serves official bytes:

```bash
curl -s https://<mirror>/2025.12.30/manifest.json | jq '.assets[] | {filename, sha256}'
sha256sum OpenSCAD-2025.12.30-x86-64.zip
```

The pinned table in `scripts/provision-lib.mjs` is the authority; the manifest
is generated from it, and `accept-mirror-manifest.mjs` fails when the two drift.
