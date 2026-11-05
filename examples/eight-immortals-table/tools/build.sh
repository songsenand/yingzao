#!/usr/bin/env bash
# 重建：参数化 SCAD -> STL
set -euo pipefail
cd "$(dirname "$0")/.."
python3 tools/gen.py
mkdir -p cad/stl
for p in leg rail apron panel_outer panel_middle cleat spline wedge pin; do
  openscad -o "cad/stl/$p.stl" "cad/$p.scad" >/dev/null
done
openscad -o cad/stl/assembly.stl cad/assembly.scad >/dev/null
echo "built cad/stl/*.stl"
echo "干涉自检：在 CAD 运行环境里执行 tools/check_interference.py（需要 trimesh）"
