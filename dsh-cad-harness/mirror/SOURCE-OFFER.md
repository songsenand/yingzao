# OpenSCAD source offer

This directory accompanies the OpenSCAD binaries mirrored at
`https://blog-songsenand.oss-cn-hangzhou.aliyuncs.com/openscad/2025.12.30/`
(and any mirror set through `CAD_OPENSCAD_MIRROR`).

The mirrored files are **unmodified** copies of the official nightly snapshots
published at `https://files.openscad.org/snapshots/`. Their SHA-256 values are
pinned in `scripts/provision-lib.mjs` and listed in `manifest.json` here, so
anyone can check that the mirror serves the official bytes and not a rebuild.

## Written offer (GPL-2.0, section 3(b))

OpenSCAD is licensed under the GNU General Public License, version 2.
Redistributing the binaries obliges us to make the corresponding source
available. We offer, valid for at least three years from the date a given
snapshot is first mirrored:

- a complete machine-readable copy of the corresponding source code for the
  mirrored OpenSCAD build, on a medium customarily used for software
  interchange, for no more than our cost of physically performing the transfer;
- or, on request, the URL of an equivalent source archive.

Requests: open an issue at <https://github.com/songsenand/yingzao/issues>, or
write to <songsenand@163.com>. Please name the snapshot version
(e.g. `2025.12.30`) and the platform archive you received.

## Where the source also lives upstream

- OpenSCAD repository: <https://github.com/openscad/openscad>
- Upstream snapshot index: <https://files.openscad.org/snapshots/>
- License text: [`LICENSE.GPL-2.0`](LICENSE.GPL-2.0)

We do not modify OpenSCAD. The plugin invokes it as a separate program over a
process boundary; no OpenSCAD code is linked into, or distributed inside, this
project's npm package.
