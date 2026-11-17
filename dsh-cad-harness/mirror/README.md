# Mirror directory

The OpenSCAD binaries are **not** in this repository and **not** in the npm
package. They are hosted on a public object store so that users in regions
where `files.openscad.org` is slow do not wait minutes for a 40–85 MB download.

This directory carries the parts a redistributor must publish alongside those
binaries, so the mirror is verifiable rather than an opaque personal bucket:

| File | Why it exists |
|---|---|
| `LICENSE.GPL-2.0` | OpenSCAD is GPL-2.0; redistribution must carry the license text |
| `SOURCE-OFFER.md` | GPL-2.0 §3(b) written offer for the corresponding source |
| `manifest.json` | Per-file SHA-256, size, official URL and mirror URL — generated, never hand-edited |

## Publishing a snapshot

1. Put the official archives in the mirror directory (same filenames as
   upstream). Do not rebuild or repack them: the pinned SHA-256 must match.
2. `node scripts/build-mirror-manifest.mjs` regenerates `manifest.json` from the
   pinned table in `scripts/provision-lib.mjs`.
3. `node scripts/build-mirror-manifest.mjs --dir <dir-of-archives>` verifies the
   archives against the pinned hashes before you upload them.
4. Upload the archives plus `LICENSE.GPL-2.0`, `SOURCE-OFFER.md` and
   `manifest.json` to the same prefix the code points at.

## Checking a mirror

Anyone can confirm the mirror serves official bytes:

```bash
curl -s https://<mirror>/2025.12.30/manifest.json | jq '.assets[] | {filename, sha256}'
sha256sum OpenSCAD-2025.12.30-x86-64.zip
```

The pinned table in `scripts/provision-lib.mjs` is the authority; the manifest
is generated from it, and `accept-mirror-manifest.mjs` fails when the two drift.
