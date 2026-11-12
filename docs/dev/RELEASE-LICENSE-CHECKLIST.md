# 0.1.0-preview 许可检查清单

> 预览版不随包分发 OpenSCAD、BOSL2 或 Python 运行时；它们由用户安装/首次使用下载。
> 本清单在每次 `npm pack` 前后各跑一次。

## 包内必须存在

- [ ] `LICENSE`（Apache-2.0 全文）
- [ ] `NOTICE`（本项目与第三方声明）
- [ ] `README.md`
- [ ] `package.json` 的 `license: "Apache-2.0"`

## 包内必须不存在

- [ ] `bin/`（OpenSCAD AppImage）
- [ ] `lib/BOSL2/`（BSD-2，用户自行下载）
- [ ] `node_modules/`
- [ ] `*.AppImage`
- [ ] `python/.../site-packages`（运行时由首次使用下载）
- [ ] `cad-data/` 或任何用户项目语料

## 每次发布

```bash
cd dsh-cad-harness
npm pack --dry-run --json | node -e '...'   # 或 npm run accept:license
npm run rehearse:preview                    # 解包后检查同一组文件
```

`accept:license` 检查 `package.json.files` 和包根文件；`rehearse:preview` 检查真实 tarball
的条目，防止 `files` 与实际打包不一致。

## 不在本清单内

- OpenSCAD 以独立进程调用，不链接；其 GPL 义务由用户安装的副本承担。
- BOSL2 由用户从上游获取，仓库和 tarball 都不包含。
- Python 运行时与科学计算包由 `python_runtime` 在用户机器上下载，tarball 不包含。
