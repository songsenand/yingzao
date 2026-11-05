# model / 装配契约（通用）

> 契约是 `model` 的产物，不是 `fit` 凭空假设的前置条件。
> 这里只讲通用做法；行业接触组/阈值由项目 rule pack 决定。

## 1. 先有零件版本

每个 child 必须引用一个已存在的版本；没有版本就先 `generate_part` / `import_part`。

## 2. 声明配合面 datum

```text
set_datums({versionId:"<version>", datums:[
  {name:"face_a", kind:"plane", point:[0,0,0], normal:[0,0,1]}
]})
```

`set_datums` 生成新版本；把新 `versionId` 写回 assembly manifest 的对应 child。

## 3. 写 assembly manifest

用 `write_assembly` 写（不是通用 `write`/`run_python`）：

```text
write_assembly({mode:"merge", expectedHash:"sha256:…", root:{children:[…], interfaces:[…]}})
```

`assembly/assembly.json` 的 `root`：

- `children`: 直接子件 + version + transform；
- `interfaces`: `<childId>.<datumName>` 对，`check`/`expected`/`tolerance`；
- 先声明结构主链，再补接触面；不要用巨大 tolerance 掩盖错误；
- `write_assembly` 会校验 child version、datum 端点、直接 child、ID 和 expectedHash；它不会算距离。

## 4. 自检

```text
check_assembly({manifestPath:"assembly/assembly.json"})
validate_assembly({clearanceThreshold:0, interferenceEpsilonMm3:<project>})
```

- `interfaces=0` → 契约还没有，不是通过；
- `hardViolations>0` → 回 datum/接口，不回几何；
- `undeclared` 按项目 rule pack 处理（0 / required groups / 逐条解释）。

## 5. 完成判据

- 契约文件存在，且 child 版本与当前模型一致；
- `check_assembly` 至少跑过一次，硬冲突为 0；
- 新版本 STL 与父版本一致（如果只是加 datum）；
- `validate_assembly` 的阈值由项目声明，不写死在模板里。
