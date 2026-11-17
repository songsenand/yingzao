# Library geometry generator

Authoring/build-time only. The plugin runtime does **not** need CadQuery or OCP;
it reads the generated STEP/STL and `part.json` files.

The generator has a persistent local venv at `library/generator/.venv/`
(gitignored, about 1.7 GB). It is a build-time tool; the plugin runtime does not
need it.

```bash
cd dsh-cad-harness/library/generator
uv pip install --python .venv/bin/python \
  --index-url https://mirrors.aliyun.com/pypi/simple -r requirements.lock
.venv/bin/python generate.py
```

`requirements.lock` pins the exact transitive set used to generate the committed
artifacts. Recreate the venv with the same Python (3.13) if you need byte-level
reproducibility.

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
