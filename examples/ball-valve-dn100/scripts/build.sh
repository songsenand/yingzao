#!/usr/bin/env bash
# Build every part mesh from source/valve.scad into out/stl/<part>.stl.
# Requires: openscad on PATH. Deterministic (fixed $fn in the source).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p out/stl
parts=(body cap ball seat stem gland handle packing gasket fluid-open fluid-45 fluid-closed)
for p in "${parts[@]}"; do
  openscad -q -o "out/stl/$p.stl" --export-format binstl -D "PART=\"$p\"" source/valve.scad
  echo "built out/stl/$p.stl"
done
