# Library geometry generator

Authoring/build-time only. The plugin runtime does **not** need CadQuery or OCP;
it reads the generated STEP/STL and `part.json` files.

```bash
# from dsh-cad-harness/
uv pip install --target .tmp-cadquery \
  --index-url https://mirrors.aliyun.com/pypi/simple cadquery

PYTHONPATH=$PWD/.tmp-cadquery \
  /home/songsenand/.dsh/cad/runtime/venv/bin/python \
  library/generator/generate.py
```

`generate.py`:

- reads `library/catalog.json`;
- builds each catalog spec with CadQuery 2.8.0;
- writes `library/parts/<id>/fit/{model.step,model.stl}`, optional
  `visual/`, and `part.json`;
- updates catalog `status` / `lod.*.model` with relative paths + hashes;
- keeps the `visual` bbox inside the `fit` envelope (and fails otherwise).

`dimensions.py` is the nominal v0 dimension table. It is **not** a standard
compliance certificate; each `part.json` records `dimensionSource`.

Expected v0 output: 99 specs, 55 `alias-fit` visuals, 44 distinct visuals;
286 geometry files (143 STEP + 143 STL) + 99 `part.json` = 385 files.
