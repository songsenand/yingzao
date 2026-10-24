# Panel UI sandbox

Renders the **real** `CadPanel` (`src/client/panel.ts`) against the **real**
`data/` store (versions + `data/runs/`) in a stand-in right dock, so UI work can
be reviewed in a headless browser without touching the live GUI.

## Why

The panel normally lives in the right sidebar of the dsh web shell, which needs
a login token and is not scriptable from here. This harness mounts the same
component at the same dock geometry (default 380×900) and serves `/api/cad/*`
from `data/`, so what you see is the shipping UI, not a mockup.

Headless Firefox 156 does **not** composite WebGL canvases into `--screenshot`
captures (see `webgl-raf-probe.html`), so `entry.tsx` freezes each panel canvas
into a positioned `<img>` before the capture fires. That freeze is sandbox-only.
(It is independent of the WebGL-availability problem below: the freeze makes the
canvas *survive* the capture, `shot-gl.mjs` makes it *exist*.)

## Run

```sh
# 1. build the panel bundle (esbuild, react/react-dom bundled for the browser)
node sandbox/preview/build.mjs            # add --watch while iterating

# 2. serve it (mock CAD API over data/)
node sandbox/preview/server.mjs 4173

# 3. capture — use shot-gl.mjs whenever the picture must contain the MODEL
node sandbox/preview/shot-gl.mjs --name prod-default --query 'w=380&h=900'
#    DOM-only review (lists/layout/reports) can use the cheaper headless one:
node sandbox/preview/shot.mjs --name tree --query 'w=380&h=900'
```

Open `http://127.0.0.1:4173/?w=380&h=900` in a real browser to click around.

## Query parameters

| param | meaning |
|---|---|
| `w` / `h` | dock width / viewport height (defaults 380×900) |
| `kind` | drive the 种类 select: `part` / `assembly` / `sim` / `contract` / `unregistered` |
| `subject` | pick a part (or, in the `unregistered` kind, a file path) through the navigator |
| `record` | drive the 记录 select to a version or run id (`v021`, `r003`) — picks it for real, so the panel pins (跟随 → 已钉住) exactly as a click would |
| `nav` | `1` = open the product navigator (the breadcrumb overlay) — the 类别/条目/记录 selects no longer exist |
| `navpick` | open the navigator and click one row by product id (`p005`, `v066`, `r013`, `machine`, a file path). This is how `subject`/`record` now select |
| `navq` | type into the navigator's search box (native setter + input event), e.g. `navq=滑座` |
| `open` | click something after mount — a tab (`参数`, `用法`), a toolbar chip (`剖切`, `壁厚`, `测量`, `截图`) or `⤢`/`⤡`. **Comma-separated for a sequence**: `open=参数,⤢` selects the tab then expands it into the overlay |
| `wheel` | wheel-delta to push through OrbitControls (e.g. `-1400` zooms in) — lets a screenshot prove the scale bar re-ranges |
| `reset` | click `复原` after the wheel, to prove the camera returns to its initial framing |
| `freeze=0` | disable the WebGL→`<img>` freeze |
| `debug=0` | disable the layout probe printed into the empty left column |
| `fakerenderer=1` | stand a 2D canvas in as `mount.__renderer`, so the **capture plumbing** (📸截图 → tray → badge → hint) can be reviewed without WebGL. It draws an obvious placeholder — **those pixels are not 3D** and must never be presented as a model render |
| `bg` | pre-seed the viewport ground preset (`paper` / `warm` / `graphite` / `midnight`) into the same localStorage key the panel reads, so a capture can show any of them without clicking |
| `overlay=1` | mount **only** the real `ViewportOverlay` against a synthetic camera (a no-WebGL sandbox cannot build a scene), then measure the merged corner plate and assert every axis letter stays inside it (`overlay-corners.png`) |
| `recent` | pre-seed the MRU list (`recent=p005,v066`), so "reopen where you left off" can be captured in a fresh profile |
| `assert=recent` | with `expect=<text>`: assert the breadcrumb reopened on that address (no param = assert it opened somewhere) |
| `assert=machine` | with `expect=<name>`: assert the navigator has a 机器 row, the breadcrumb names it, and its tabs carry the evidence and node counts |
| `assert=evidence` | click 证据 and assert the evidence table is scannable: every row carries its run id, names a version, and the same-mechanism rows (机构运动) have distinct second lines; exact-duplicate runs are reported, not failed |
| `assert=layout` | run the layout-stability assertion: click 测量 → 壁厚 → 剖切 → 参数 → 截图 and compare **every** region's and every chip's `w/h/y` against the baseline, printing PASS/FAIL into the screenshot. Absolute- AND fixed-positioned overlays are excluded (they take no space) |
| `project` | stand a session cwd in front of the panel (`session.list` + binding + retention), so project-scoped UI (the local-STL import target) renders its normal state instead of the "未识别" guard |
| `localstl` | go 未登记 → 📂 按路径导入… → 预览, then feed a real STL from the mock corpus (`?localstl=v021`) through the file input, so the preview's geometry path — not just its empty state — is what gets captured |
| `assert=local-import` | go 未登记 → 📂 按路径导入… → fill path/part → submit against the mock POST; asserts the request (project, path, unit, part, `render:false`) and that the dialog closed. Note `slow=8000`: the report lands after ~3.7 s |
| `assert=layout` | as before; the debug probe now steps aside for it (both clear `#stage`, and the probe used to wipe the report mid-run) |

`CAD_SANDBOX_DATA=<dir>` makes the server read a **throwaway copy** of the store
(copy `manifest.json`, `parts/manifest.json`, `runs/manifest.json`, add whatever
corpus you need). Used to capture states the live data does not contain — e.g.
the empty-part band (`band-empty.png`) — without writing into `data/`.

## Mocked API

Mirrors the host routes the panel actually uses:

| route | source |
|---|---|
| `GET /api/cad/assembly/manifest` | the assembly manifest from `DATA/../assembly/assembly.json` (beside the corpus, like the host) — this is what makes the 机器 object appear |
| `GET /api/cad/products` | **the host's read port** (`src/host/store.ts`): snapshot cache, change sequence, `ETag`, and `304` on `If-None-Match` / `?since=` — same code path as the real route |
| `GET /api/cad/params?v=` / `GET /api/cad/stl?v=` | `data/versions/<v>/` |
| `GET /api/cad/run?id=` | the run manifest entry |
| `GET /api/cad/run/report\|trajectory\|fluid-manifest?id=` | `data/runs/<id>/` |
| `GET /api/cad/run/stl?id=&part=` | `data/runs/<id>/parts/<part>.stl` |
| `GET /api/cad/run/frame?id=&i=` | `data/runs/<id>/frames/<file>` via the run's fluid manifest |

Everything else the panel asks for is real data on disk — there are no
hand-written fixtures, and the legacy "latest run" routes are deliberately
**not** mocked so a regression to them fails loudly here.

## Screenshots

`../shots/` (captured at 380×900 unless noted):

| file | what |
|---|---|
| `baseline-380x900.png` | before any of this work: 33 version chips in 9 rows on top, viewport squeezed to 335×300 and pushed past the panel bottom |
| `prod-default.png` | newest product (`r005` fluid run) auto-selected — particle playback, timeline, run report, provenance line, corner overlays |
| `prod-version.png` | a version product: square geometry viewport + markup tools + 相关验证 / 参数 / 导出 |
| `prod-related.png` | version `v021` showing 相关验证 (1) → the `assembly-check` run that audited it |
| `prod-checkrun.png` | an `assembly-check` run: report-only card ("这次运行没有几何体") + clickable source versions |
| `final-version.png` | corner overlays on a version: triad (bottom-left), `10 mm` scale bar (bottom-right), `复原` (top-right) |
| `final-run-physics.png` | same overlays on a physics run — `100 mm` for the 120mm base plate |
| `final-run-fluid.png` | same overlays on a fluid run — `50 mm` |
| `final-zoom.png` / `final-zoom-reset.png` | zoomed in (model bbox 352×352) vs after pressing `复原` (302×279, identical to `final-version`) |
| `final-wide.png` | overlays at 520px dock width |
| `tree-part.png` | 零件→记录 two-level picker: 调焦滑座 (5版·1验证), landed on the newest **version**, not the run that was 227ms newer |
| `tree-empty.png` | an explicitly created part with **no versions yet** (`create_part`), showing 暂无记录 |
| `tree-scene.png` | the ⚙ 跨零件场景 bucket: runs whose geometry spans ≥2 parts or none |
| `row-320.png` / `row-380.png` / `row-520.png` | the one-line browse row (零件 · 记录 · 跟随) at three dock widths — identity survives the truncation |
| `row-before-after.png` | two rows + text labels + a wide 跟随 chip (top) vs the single row (bottom): the viewport moves up by ~34px |
| `layout-narrow-320x900.png` / `layout-wide-520x900.png` | the square tracks the dock width (295 / 495) |
| `layout-short-380x560.png` | short dock: the square is kept, the section list scrolls |
| `band-380x900.png` | v2.14b: viewport 355×568 (was 355×355) + bottom status band; details back to their natural 165px (was 411px of mostly empty box) |
| `band-380x560.png` / `band-380x400.png` | short docks: the viewport keeps ≥ square (355×352 / 355×233), the details shrink and scroll, the band stays visible |
| `band-380x1200.png` | tall dock: viewport 355×868 — vertical slack goes to the view, the model's apparent size is unchanged (it is bound by the width) |
| `band-520x900.png` | wide dock: 495×568, status line fits identity + description in full |
| `band-run-fail.png` | run `r003` (清单检查, fail) → `❌ 失败 · r003 · 清单检查 · 09-28 16:08 — 3 接口 …` + `来源 4 版` |
| `band-scene.png` | ⚙ 跨零件场景 → `⚠️ 待复核 · r005 · 流体仿真 … 内联 SCAD` |
| `band-empty.png` | a 0-version part (`CAD_SANDBOX_DATA` copy): the band states "该零件还没有记录" and shows **no verdict slot** |
| `band-open-run-560.png` | run report expanded at 560px: details scroll, viewport still 355×353 (never shrinks below square) |
| `local-stl-model.png` | 本地 STL preview with a **real corpus STL** (`?localstl=v021`): mesh + face count + bbox, labelled 未登记 — preview only, no version is created |
| `local-stl-import2.png` | the import tab: the write target names the SESSION corpus (`?project=…`), unit defaults to mm |
| `probe-base-380x{560,900,1200}.png` | the *old* square layout with the per-child probe: stage 355 tall at every height, details 411 / 711px |

## Sections: strip + overlay (`tabs-*.png`)

The accordion's header rows ate the detail box (4 × 26px of the 190px), so the
content had ~70px and everything scrolled. Now: a one-line tab strip, a fixed
158px body, and "⤢" lifts the section into an absolutely-positioned overlay over
the viewport (so it cannot reflow anything, and the toolbar/strip/band stay
usable while it is open).

| shot | shows |
|---|---|
| `tabs-params.png` / `tabs-params-probe.png` | all 11 parameters in a 2-column grid; the probe prints **no scroller** (was `+307px hidden, 2.6x`) |
| `tabs-params-320.png` | the same at a 320px dock |
| `tabs-sheet-params.png` / `tabs-sheet-help.png` | the overlay: sheet over the viewport only, tabs + tools + band still visible; the 用法 text fully readable |
| `tabs-tray-sheet.png` | 📸截图 opens the tray in the overlay automatically (the old "nothing happened" complaint) |
| `tabs-overview.png` | 概览: intent + `尺寸 115.0 × 115.0 × 48.0 mm · 2192 面` + a "这些按钮怎么用？" link |
| `viewtools.png` | the five tool chips live **inside the viewport**, top-left column, in the same visual language as `⤾ 复原` (which owns top-right) |
| `details-scroll-params.png` | before: `client=190 scroll=497 (+307px hidden, 2.6x)` |

## Layout stability is asserted, not eyeballed (`layout-*.png`)

The requirement is "only the viewport is flexible; every other region keeps its
size unless the page is resized", because a region that resizes the viewport also
re-fits the camera and the model jumps. `?assert=layout` turns that into a check:
after mount it clicks 测量, 壁厚, 剖切, 参数 (opens a disclosure) and 截图, taking a
box snapshot (`w/h/y` of every direct child plus every toolbar chip) after each
and diffing against the baseline.

| shot | dock | baseline viewport | details | verdict |
|---|---|---|---|---|
| `layout-stability-fake.png` | 380×900 | 355×497 | 190px | all five steps PASS |
| `layout-stability-320.png` | 320×900 | 295×497 | 190px | all five steps PASS |
| `layout-560.png` | 380×560 | 355×330 | 27px | all five steps PASS |
| `layout-tall.png` | 380×1200 | 355×797 | 190px | all five steps PASS |

It also asserts the **splitter**: ArrowUp × 2 must move exactly the body (+32)
and the viewport (−32) and nothing else, and `Home` must restore the automatic
split. The mouse drag is not headlessly testable (synthetic pointer events do not
satisfy `setPointerCapture`), so the keyboard path drives the same `setBodyH`.

The boxes differ *between* docks (a genuine resize may re-wrap and re-fit) but
never *within* one. At 380×900 the automatic split is body 260px / viewport
355×393 — the viewport is held at "square + 40" because past square the extra
height is only empty margin (the fit is bound by the shorter side), and below
square the model really shrinks. The price is stated in DESIGN §6.9e: the details are a fixed
190px scroll box (≈25px of slack when collapsed) and the feedback block is a
permanent 38px carrying the standing instructions when idle.

## Measurement fixes (2026-09-30, `meas-*.png`)

Three complaints — "放大后探针点特别大 / 薄壁没办法 / 截图点了没反应" — and what
each turned out to be. All of it was verified numerically against the real
`v034` STL (three.js in node) plus DOM-layer captures; see DESIGN §6.9d.

| shot | shows |
|---|---|
| `meas-toolbar.png` | the 5-chip toolbar (`📸截图 □标注 📏测量 ▤壁厚 ◐剖切`) still one row at 380 and at 320 |
| `meas-thick.png` | 壁厚 mode with its instruction row, which **never appeared before** (the feedback row's condition omitted the modes) |
| `meas-points.png` | 测量 mode instruction, same fix |
| `meas-section.png` | ◐剖切 with the live cut-position slider (`剖切 z=50%`) |
| `meas-shot-tray.png` | 📸截图 feedback: chip badge `(1)`, the hint row, the tray scrolled into view, and `📸 1 张待插入` in the status band — uses `fakerenderer=1`, so the thumbnail content is a placeholder, **not** 3D |

```
probe dot on screen (355×568 viewport, flange R=64.6mm)
  zoom   OLD dia   NEW dia   surface the OLD dot covers
   1x     6.1px     6.2px    2.29mm
   4x    24.5px     6.2px    2.30mm
  16x   101.0px     6.2px    2.37mm

thickness by ray — FrontSide (what the viewer had) vs DoubleSide pick mesh
  hub wall  Ø36/Ø35, ray +x      FrontSide: 1 hit, unmeasurable | DoubleSide: 0.500mm
  flange plate, ray -z at x=50   FrontSide: 1 hit, unmeasurable | DoubleSide: 16.000mm
  raised face + plate, x=25      FrontSide: 1 hit, unmeasurable | DoubleSide: 18.000mm
```

## Overlay assertions (how they were verified)

The overlays are DOM, so they appear in `--screenshot` captures directly — which
is the point of implementing them that way. The debug probe prints the overlay's
own `data-scale` / `data-ppm`, so a run proves the bar tracks the camera:

| state | probe | bar |
|---|---|---|
| initial | `ppm=6.234` | `10 mm` / 62px |
| `wheel=-500` | `ppm=8.056` | `10 mm` / 81px |
| `wheel=-1400` | `ppm=12.783` | `5 mm` / 64px |
| `wheel=-1400&reset=1` | — | model bbox identical to initial (49173 blue px, 302×279) |

## Camera fit is aspect-aware (numeric check)

The viewport is no longer square, so framing cannot be a fixed distance: the new
`src/client/fit.ts` inscribes the part's bounding sphere in the **narrower** of
the two fields of view. Verified without a renderer by projecting 4000 points on
that sphere through a real `THREE.PerspectiveCamera`:

| aspect | old fixed distance, max\|NDC\| (x,y) | `fitDistance()`, max\|NDC\| |
|---|---|---|
| 1.00 | 1.024, 1.023 | 1.000, 0.999 |
| 1.50 | 0.683, 1.023 | 0.667, 0.999 |
| 0.58 | **1.765**, 1.023 | 1.000, 0.580 |
| 0.38 | **2.694**, 1.023 | 1.000, 0.380 |

The old framing already overflowed the square by ~2% (masked because a part does
not fill its bounding sphere) and would have cut a portrait viewport in half.
WebGL pixels could not be re-checked in the session that wrote this table (see
below); rendering is available now, so re-shoot before trusting it over a render.

## WebGL needs an X display — use `shot-gl.mjs`

**Short version: plain `firefox --headless` cannot do WebGL here, and an X
display fixes it in one step.**

```sh
node sandbox/preview/shot-gl.mjs --name knob --query 'w=380&h=900&subject=p008'
```

That wrapper starts a throwaway `Xvfb`, then runs Firefox against it with
`LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe`. The probe page reports
`WEBGL OK — WebGL 2.0, renderer: llvmpipe`, and the panel renders the model.
Everything else is unchanged: same query parameters, same canvas freeze in
`entry.tsx`.

Why the difference: headless Firefox takes its headless GL path and refuses,
even with software Mesa forced (`WEBGL UNAVAILABLE`, four configurations tried,
no `/dev/dri` on this box). Under an X server it takes the GLX path instead and
Mesa's `swrast`/llvmpipe rasterises in software. `swrast_dri.so` **is** present
(`/usr/lib64/dri/`) — an earlier note in this file claimed Xvfb had "nothing to
render with"; that was wrong, and it cost a whole session of verifying 3D
changes numerically instead of looking at them. `shot.mjs` is kept for DOM-only
work (lists, pickers, reports, layout) where starting an X server would be
pointless.

If WebGL *is* unavailable (a container without Mesa), the panel degrades to a
message card rather than unmounting, and `fakerenderer=1` keeps the capture
plumbing (📸截图 → tray → badge → hint) reviewable — but those pixels are
labelled and are not a model render.

## Not wired up

Driving the live GUI headlessly (navigate → click the `CAD` header control →
screenshot) was attempted over Firefox Marionette; this Firefox build answers
the handshake but never replies to `WebDriver:NewSession`, so the attempt was
dropped. Use the sandbox above for layout review, and a browser refresh for
integration checks.
