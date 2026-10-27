// Acceptance: a replay screenshot's caption names the RUN and the FRAME.
//
// Before this, a capture from 机构回放 said only:
//   CAD 视口截图 — 机构回放 t=0.66s
//   包围盒 17.179 × 17.164 × 16.48 mm
// Three separate failures, each pinned below:
//   1. no run id / frame  -> the picture cannot be turned back into its artifact;
//   2. `t=0.66s`          -> a rounded display value shared across runs and frames;
//   3. the bbox           -> the last PART version's leftover spec, not this view.
//
//   node scripts/accept-shot-caption.mjs
import { partShotCaption, runShotCaption } from '../src/client/shot-caption.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const run = (over = {}) => ({
  id: 'r021',
  title: '机构运动 · 弯臂 + 调焦滑座 + 齿轮轴',
  sourceVersionIds: ['v014', 'v025'],
  ...over,
});
// 50 fps: an event within half a step (0.01s) belongs to the frame.
const frame = (over = {}) => ({
  index: 20,
  total: 121,
  timeSec: 0.66,
  stepSec: 0.02,
  events: [
    { timeSec: 0.66, label: '横梁接触限位' },
    { timeSec: 0.5, label: '上一次碰撞' },
  ],
  ...over,
});

// ---- 1. identity: run id + frame, not just the view type --------------------
{
  const text = runShotCaption(run(), '机构回放 t=0.66s', frame());
  const [line1, line2] = text.split('\n');
  check(line1 === 'CAD 视口截图 — r021「机构运动 · 弯臂 + 调焦滑座 + 齿轮轴」· 机构回放 t=0.66s',
    'run id and title lead the first line', String(line1));
  check(line2.includes('帧 20/121'), 'the exact frame rides with the picture', String(line2));
  check(line2.includes('几何来自 v014 + v025'), 'the cited versions are named', String(line2));
  check(line2.includes('事件 0.66s 横梁接触限位'), 'the event ON this frame is named', String(line2));
  check(!line2.includes('上一次碰撞'), 'a neighbouring event is not claimed as this frame', String(line2));
  check(!text.includes('包围盒'), 'no bbox: the replay owns no part-viewport spec', text);
}

// ---- 2. the same t in two runs (or two frames) is NOT the same picture ------
{
  const a = runShotCaption(run(), '机构回放 t=0.66s', frame());
  const b = runShotCaption(run({ id: 'r061', title: '机构运动 · 整机' }), '机构回放 t=0.66s', frame());
  check(a !== b && a.includes('r021') && b.includes('r061'),
    'two runs at the same t get different captions', `${a.split('\n')[0]} | ${b.split('\n')[0]}`);
  const c = runShotCaption(run(), '机构回放 t=0.66s', frame({ index: 21 }));
  check(a !== c && c.includes('帧 21/121'), 'two frames that display the same t stay distinct', c.split('\n')[1]);
}

// ---- 3. no frame (static assembly) is a still: no 帧 line -------------------
{
  const text = runShotCaption(run({ id: 'r013', title: '装配间隙 · 底座 + 立柱' }), '装配静置视图');
  check(!text.includes('帧 '), 'a still has no frame number', text);
  check(text.includes('r013「装配间隙 · 底座 + 立柱」'), 'a still still cites its run', text);
}

// ---- 4. provenance edge cases ----------------------------------------------
{
  const stale = runShotCaption(run({ staleVersionIds: ['v014'] }), '机构回放 t=0.66s', frame());
  check(stale.includes('源版本已过期'), 'expired evidence says so', stale.split('\n')[1]);
  const dup = runShotCaption(run({ sourceVersionIds: ['v014', 'v014'] }), '机构回放 t=0.66s', frame());
  check(dup.endsWith('几何来自 v014'), 'repeated versions are deduplicated', dup.split('\n')[1]);
  const none = runShotCaption(run({ sourceVersionIds: [] }), '流体回放 t=1s');
  check(!none.includes('几何来自'), 'a run with no cited versions says nothing', none);
}

// ---- 5. the event rule is "on this frame", not "nearest wins" ---------------
{
  const edge = runShotCaption(run(), '机构回放 t=0.66s', frame({ events: [{ timeSec: 0.67, label: '半个步长' }] }));
  check(edge.includes('半个步长'), 'half a frame step still counts as this frame', edge.split('\n')[1]);
  const out = runShotCaption(run(), '机构回放 t=0.66s', frame({ events: [{ timeSec: 0.671, label: '超过半个步长' }] }));
  check(!out.includes('超过半个步长'), 'more than half a step is another frame', out.split('\n')[1]);
  const long = runShotCaption(run(), '机构回放 t=0.66s', frame({
    events: [{ timeSec: 0.66, label: '干涉：一个非常非常长的碰撞描述'.repeat(6) }],
  }));
  check(long.includes('…') && long.split('\n')[1].length < 90, 'a long event label is clipped', String(long.split('\n')[1]?.length));
}

// ---- 6. part versions: old revision / heatmap / comparison inset -----------
{
  const latest = partShotCaption({
    partName: '弯臂', versionId: 'v069', latestVersionId: 'v069', label: '截图',
    bboxMm: [83.88, 83.88, 88],
  });
  check(latest === 'CAD 视口截图 — 零件「弯臂」 · 版本 v069 · 截图\n包围盒 83.88 × 83.88 × 88 mm',
    'the plain part caption stays two short lines', latest);

  const stale = partShotCaption({
    partName: '弯臂', versionId: 'v069', latestVersionId: 'v077', label: '截图',
  });
  check(stale.includes('版本 v069（旧版·最新 v077）'),
    'an old revision says it is old and names the latest', stale.split('\n')[0]);

  const heat = partShotCaption({
    partName: '弯臂', versionId: 'v069', latestVersionId: 'v069', label: '截图',
    heatLegend: '壁厚 · 来源 r012（printability）',
  });
  check(heat.includes('热力图：壁厚 · 来源 r012（printability）'),
    'the heatmap legend travels with the colours (DOM chip is not in the canvas)', heat.split('\n')[1]);

  const compare = partShotCaption({
    partName: '弯臂', versionId: 'v069', latestVersionId: 'v077', label: '截图',
    compare: { blue: { role: '历史', id: 'v069' }, orange: { role: '当前', id: 'v077' } },
  });
  check(compare.includes('副视口：蓝 = 历史 v069 · 橙 = 当前 v077'),
    'the inset key travels with the inset picture', compare.split('\n')[1]);

  const overlays = partShotCaption({
    partName: '弯臂', versionId: 'v069', latestVersionId: 'v069', label: '测量 12.34mm',
    measureMm: { dist: 12.34, a: [1, 2, 3], b: [4, 5, 6] },
    thicknessMm: 0.5, annotations: 2, section: { axis: 'y', keepPct: 0.4 },
  });
  check(overlays.includes('剖视：沿 y 轴、保留 40% 侧') &&
    overlays.includes('两点测量 12.34 mm') &&
    overlays.includes('壁厚 0.50 mm') && overlays.includes('2 处标注框'),
    'section / measure / thickness / annotations still ride along', overlays.split('\n')[1]);

  const plain = partShotCaption({ partName: '弯臂', versionId: 'v069', latestVersionId: 'v069', label: '截图' });
  check(!plain.includes('热力图') && !plain.includes('副视口') && !plain.includes('旧版'),
    'an untouched latest capture carries none of those facts', plain);
}

console.log(failures === 0 ? '\nOK — captions carry identity and the facts the pixels cannot' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
