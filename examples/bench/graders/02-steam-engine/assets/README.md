# assets · 外购件夹具（**评分方侧**）

> 本文件在 `graders/` 下，**不进会话**。生成出来的 `608.stl` 要放到考生侧：
> `examples/bench/subjects/02-steam-engine/assets/608.stl`。

## `608.stl`（**未入库，运行前生成一次**）

| 项 | 值 |
|---|---|
| 用途 | `02-steam-engine` 的 `import_part` 车道：绕一颗买来的轴承做设计 |
| 外形 | 608：OD 22、内孔 8、宽 7 |
| 性质 | **示意实体，不是功能轴承** |
| 生成 | 见下方命令，输出到考生侧 assets |
| 入库 | ❌ 生成物，已 gitignore，避免提交二进制 |

```bash
cd examples/bench/graders/02-steam-engine/assets
OPENSCADPATH=<repo>/lib openscad -o ../../../../subjects/02-steam-engine/assets/608.stl make-608.scad
```

**为什么不做成真实轴承**：真实 608 是三个互不接触的体（外圈、内圈、滚珠）。
`import_part` 走 Manifold 校验，`check_connectivity` 也强制"一个零件 = 一个连通体"，
所以**忠实建模反而会被正确拒收**。import 车道要的是"一个尺寸正确、买得到、
形状规整的实心件"——单位要靠声明、datum 要靠自己补、能不能当接口端点要看
它有没有版本，这三件事才是考点。滚道槽只做了浅浅两圈，纯为了渲染时轮廓可读。

**生成后先验证**：直接 `import_part` 一次。它不是闭合实体就会被拒——
**那是守卫，不是障碍**。若被拒，先查 `make-608.scad` 的差值运算是否把体切断了。

> 首版 `make-608.scad`（外圈 + 内圈 + 8 颗滚珠并集）生成后 OpenSCAD 报
> `Volumes: 2`——非单连通体，`import_part` 会正确拒收，且 STL 达 4MB。现行版本
> 改为"带内孔的实心外形 + 两道浅滚道槽"，保证单连通且体积小。

## 以后可能加的夹具

- `spring.stl`：给弹簧预紧接口用的标准压簧（若第 2 题需要）
- 其余外购件（销轴、铜螺母）沿用生成件，不进 assets
