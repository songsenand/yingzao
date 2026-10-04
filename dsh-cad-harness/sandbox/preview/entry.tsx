// Sandbox entry: mount the REAL CadPanel into a stand-in right dock.
// Query params: ?w=380&h=900 — dock width / viewport height.
//
// Headless Firefox does not composite WebGL canvases into `--screenshot`
// captures, so we freeze each panel canvas into a positioned <img> overlay
// before the screenshot fires. Sandbox-only: nothing here ships.
import React from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { CadPanel, setClientServices } from '../../src/client/panel';
import { ViewportOverlay } from '../../src/client/overlay';

const q = new URLSearchParams(location.search);
const w = Number(q.get('w') ?? 380);
const h = Number(q.get('h') ?? 900);
const freeze = q.get('freeze') !== '0';

// ?bg=<id> — pre-seed the remembered viewport ground (lighting.ts reads this
// key), so a capture can show any preset without clicking the swatch. Same
// storage the real panel uses; nothing production-side is aware of the sandbox.
const bgParam = q.get('bg');
if (bgParam) {
  try { localStorage.setItem('cad.viewportBg', bgParam); } catch { /* capture-only */ }
}

document.documentElement.style.setProperty('--dock-w', `${w}px`);
document.documentElement.style.setProperty('--stage-h', `${h}px`);

// ?subject=<partId>|__scene__ — drive the 零件 select after mount (React listens
// to the native `change`, so a value set + dispatch is enough). No production
// hook is needed for this: the sandbox drives the real DOM.
const subjectParam = q.get('subject');
function selectByIndex(index: number, value: string) {
  const sel = document.querySelectorAll('#root select')[index] as HTMLSelectElement | undefined;
  if (!sel) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(sel, value);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
// The browse bar is now THREE selects (DESGIGN §20): [0] 种类, [1] 条目, [2] 版本.
const selectKind = (value: string) => selectByIndex(0, value);
const selectSubject = (value: string) => selectByIndex(1, value);
/** ?record=r003 — drive the 版本 select (3rd select) to a version or run id. */
const selectRecord = (value: string) => selectByIndex(2, value);

// Surface page errors into the capture: with React unmounting the tree on a
// render throw, the screenshot would otherwise just be an empty dock.
function reportError(label: string, detail: unknown) {
  const box = document.createElement('pre');
  box.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:100000;max-width:60vw;max-height:40vh;overflow:auto;' +
    'margin:0;padding:8px 10px;background:#fee;border:1px solid #c0392b;border-radius:6px;' +
    'color:#7b241c;font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap';
  box.textContent = `${label}\n${String(detail)}`;
  document.body.appendChild(box);
}
window.addEventListener('error', (e) => reportError('page error', `${e.message}\n${e.error?.stack ?? ''}`));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as Error;
  reportError('unhandled rejection', `${r?.message ?? r}\n${r?.stack ?? ''}`);
});

const root = document.getElementById('root');

// ?overlay=1 — mount ONLY the real ViewportOverlay against a synthetic camera.
// The overlay needs a live camera, which no-WebGL environments cannot build, so
// this is the only way to check the corner plate (merged triad + scale bar) and
// to assert that the axis letters stay inside it.
if (q.get('overlay') === '1') {
  const cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
  cam.position.set(160, 120, 160);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  const scene = { camera: cam, focus: new THREE.Vector3(0, 0, 0) };
  if (root) createRoot(root).render(React.createElement('div', {
    style: { position: 'relative', width: w, height: h, background: '#f0f0f0' },
  }, React.createElement(ViewportOverlay, {
    getScene: () => scene,
    onReset: () => {},
    labels: [
      { key: 'thick', text: '壁厚 0.50 mm', world: [0, 0, 0], color: '#00838f' },
      { key: 'behind', text: '不应出现', world: [-400, 0, -400], color: '#c0392b' },
    ],
  })));

  setTimeout(() => {
    const lines: string[] = [`overlay sandbox ${w}×${h}`];
    const plate = document.querySelector('#root [data-plate], #root div[style*="absolute"]') as HTMLElement | null;
    const svg = document.querySelector('#root svg') as SVGSVGElement | null;
    const labels = Array.from(document.querySelectorAll('#root svg text'));
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    // The plate is the outermost absolutely-positioned div of the overlay.
    const plateEl = document.querySelector('#root [data-corner]') as HTMLElement | null;
    if (plateEl) {
      const p = rect(plateEl);
      lines.push(`plate: ${p.w.toFixed(1)}×${p.h.toFixed(1)} at (${p.l.toFixed(1)},${p.t.toFixed(1)})`);
      let worst = -Infinity;
      let outside = 0;
      for (const l of labels) {
        const b = rect(l);
        // how far the letter sticks out of the plate, in px (negative = inside)
        const over = Math.max(p.l - b.l, p.t - b.t, b.r - p.r, b.b - p.b);
        worst = Math.max(worst, over);
        if (over > 0) outside++;
        lines.push(`  axis ${(l.textContent ?? '?').trim()}: ${b.w.toFixed(1)}×${b.h.toFixed(1)} inset ${(-over).toFixed(1)}px`);
      }
      lines.push(outside === 0
        ? `PASS  all ${labels.length} axis letters inside the plate (tightest inset ${(-worst).toFixed(1)}px)`
        : `FAIL  ${outside} letter(s) outside the plate (worst ${worst.toFixed(1)}px)`);
      lines.push(`scale readout: ${document.querySelector('#root [data-scale]') ? 'live' : 'static'}`);
      // Pinned chips: positioned by projecting their world point every frame, so
      // check they land where the projection says and that an off-screen one hides.
      const surface = plateEl.parentElement ?? plateEl;
      const sr = surface.getBoundingClientRect();
      for (const chip of Array.from(document.querySelectorAll('#root [data-label]')) as HTMLElement[]) {
        const b = chip.getBoundingClientRect();
        const visible = getComputedStyle(chip).display !== 'none';
        if (!visible) { lines.push(`chip ${chip.dataset.label}: hidden (off-screen)`); continue; }
        const cx = b.left + b.width / 2 - sr.left;
        const cy = b.top + b.height - 8 - sr.top;   // the chip sits above its point
        lines.push(`chip ${chip.dataset.label}: "${chip.textContent}" at (${cx.toFixed(0)},${cy.toFixed(0)}) in ${sr.width.toFixed(0)}×${sr.height.toFixed(0)}`);
      }
      if (svg) lines.push(`svg viewBox: ${svg.getAttribute('viewBox')}`);
    } else {
      lines.push('FAIL  plate not found');
    }
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    pre.textContent = lines.join('\n');
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
  }, 900);
}

// ?assert=insert — the sandbox has no conversation service, so stub the documented
// attachment API in its real order and prove the panel's glue calls it:
//   sessions.scope(id) -> sessions.sessionOf(actx) -> conversation.createDrafts
//   -> conversation.sendSession(face, text, ids, 'queue')
// The stub also fails the first send on demand (?sendfail=1) to prove the
// composer fallback still parks the image instead of leaking the draft.
if (q.get('assert') === 'insert') {
  const sendFails = q.get('sendfail') === '1';
  const log: string[] = [];
  const actx = { stub: 'actx' };
  const face = { stub: 'face' };
  const drafts = [{ id: 'draft-1', kind: 'image' }];
  setClientServices({
    sessions: {
      list: { get: () => ({ current: 'session-1' }) },
      scope: (id: string) => { log.push(`sessions.scope(${id})`); return actx; },
      sessionOf: (a: unknown) => { log.push(`sessions.sessionOf(${a === actx ? 'actx ✓' : 'wrong ctx'})`); return face; },
    },
    conversation: {
      createDrafts: (sid: string, files: File[]) => {
        log.push(`createDrafts(${sid}, ${files.length}× ${files[0]?.name} ${files[0]?.type} ${files[0]?.size}B`);
        return drafts;
      },
      sendSession: async (f: unknown, text: string, ids: string[], mode: string) => {
        log.push(`sendSession(${f === face ? 'face ✓' : 'wrong face'}, ${JSON.stringify(text)}, [${ids.join(',')}], '${mode}')`);
        if (sendFails) { log.push('  ↳ sendSession threw (simulated)'); throw new Error('simulated refusal'); }
        return { kind: 'success' };
      },
      input: { for: (a: unknown) => { log.push(`input.for(${a === actx ? 'actx ✓' : 'wrong ctx'})`); return { addAttachments: (ids: string[]) => { log.push(`addAttachments([${ids.join(',')}])`); return true; } }; } },
      releaseDraftAttachments: () => log.push('releaseDraftAttachments (leak!)'),
    },
  });
  if (root) createRoot(root).render(React.createElement(CadPanel));
  setTimeout(() => {
    clickByText('截图');
    setTimeout(() => {
      const spans = Array.from(document.querySelectorAll('#root span, #root button')).map((s) => s.textContent ?? '');
      const hint = spans.find((t) => t.includes('发送') || t.includes('插入') || t.includes('复制') || t.includes('浮层里'));
      const chip = spans.find((t) => t.includes('张截图'));
      const pre = document.createElement('pre');
      pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
      pre.textContent = [
        `send-to-context glue (stubbed API, sendFails=${sendFails})`,
        ...log.map((l, i) => `  ${i + 1}. ${l}`),
        `band chip: ${chip ?? '(none)'}`,
        `hint shown: ${hint ?? '(none)'}`,
      ].join('\n');
      const el = document.getElementById('stage');
      if (el) { el.textContent = ''; el.style.alignItems = 'flex-start'; el.appendChild(pre); }
    }, 700);
  }, 2400);
}

if (root && q.get('overlay') !== '1' && q.get('assert') !== 'insert') createRoot(root).render(React.createElement(CadPanel));

// Drive the panel into a state worth capturing. A fixed timeline because the
// order matters: disclosure -> camera move -> reset -> freeze -> screenshot.
const clickByText = (text: string) => {
  const btn = Array.from(document.querySelectorAll('#root button'))
    .find((b) => (b.textContent ?? '').includes(text));
  if (btn) (btn as HTMLButtonElement).click();
  return !!btn;
};

/** Wheel events are enough to move the OrbitControls camera (no pointer
 *  capture, which synthetic pointer events cannot satisfy). */
const wheel = (deltaY: number) => {
  const el = document.querySelector('#root canvas') as HTMLCanvasElement | null;
  if (!el) return false;
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new WheelEvent('wheel', {
    deltaY, bubbles: true, cancelable: true,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }));
  return true;
};

const openParam = q.get('open');
const recordParam = q.get('record');
const wheelParam = q.get('wheel');
const resetParam = q.get('reset');
const kindParam = q.get('kind');
if (kindParam) setTimeout(() => selectKind(kindParam), 1200);
if (subjectParam) setTimeout(() => selectSubject(subjectParam), 1400);
// After the subject: the record list it renders only exists once that landed.
if (recordParam) setTimeout(() => selectRecord(recordParam), 1750);
// `open` accepts a comma-separated sequence: `open=参数,⤢` clicks the tab, then
// expands it into the overlay.
if (openParam) {
  const seq = openParam.split(',').map((x) => x.trim()).filter(Boolean);
  seq.forEach((text, i) => setTimeout(() => clickByText(text), 1900 + i * 350));
}
if (wheelParam) {
  setTimeout(() => {
    for (let i = 0; i < Math.abs(Number(wheelParam)); i += 100) wheel(Math.sign(Number(wheelParam)) * 100);
  }, 2000);
}
if (resetParam) setTimeout(() => clickByText('复原'), 2600);


if (freeze) {
  const done = new WeakSet<HTMLCanvasElement>();
  // Replace the canvas *in place* with its frozen frame. A fixed-position
  // overlay would sit above the DOM corner overlays (triad / scale bar) and
  // hide exactly what we are here to look at.
  const freezeCanvas = () => {
    for (const c of Array.from(document.querySelectorAll('#root canvas'))) {
      if (done.has(c)) continue;
      const rect = c.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) continue; // not a viewport yet
      done.add(c);
      let url = '';
      try { url = c.toDataURL('image/png'); } catch { continue; }
      if (url.length < 100) continue;
      const img = document.createElement('img');
      img.dataset.frozen = '1';
      img.src = url;
      Object.assign(img.style, {
        position: 'absolute', left: '0', top: '0',
        width: `${rect.width}px`, height: `${rect.height}px`,
        pointerEvents: 'none',
      } as CSSStyleDeclaration);
      if (c.parentElement) c.parentElement.replaceChild(img, c);
    }
  };
  // The panel mounts, fetches the STL, then renders — sample late enough.
  setTimeout(freezeCanvas, 2900);
  setTimeout(freezeCanvas, 3100);
}

// ?fakerenderer=1 — this sandbox has no WebGL context (read-only /dev/shm), so
// the panel shows its "no WebGL" card. That blocks the CAPTURE plumbing
// (📸截图 → captureCanvas → tray → copy), which is plain DOM + 2D canvas and has
// nothing to do with 3D. This stands in a 2D canvas as the renderer so that path
// can still be reviewed. It draws an obvious placeholder: the pixels are NOT 3D
// and such a shot must never be presented as a model render.
if (q.get('fakerenderer') === '1' || q.get('assert') === 'insert') {
  setTimeout(() => {
    const stage = Array.from(document.querySelectorAll('#root div'))
      .find((d) => /WebGL/.test(d.textContent ?? '') && d.children.length <= 3);
    const mount = stage?.firstElementChild as HTMLElement | undefined;
    if (!mount) { console.warn('[sandbox] fakerenderer: no mount found'); return; }
    const fake = document.createElement('canvas');
    fake.width = 710; fake.height = 1136;
    const g = fake.getContext('2d')!;
    g.fillStyle = '#f0f0f0'; g.fillRect(0, 0, fake.width, fake.height);
    g.fillStyle = '#7aa7d9';
    g.beginPath(); g.arc(fake.width / 2, fake.height / 2, 210, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f0f0f0';
    g.beginPath(); g.arc(fake.width / 2, fake.height / 2, 62, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#7b241c'; g.font = 'bold 28px sans-serif';
    g.fillText('SANDBOX RENDERER STAND-IN — NOT 3D', 60, 80);
    (mount as unknown as { __renderer?: unknown }).__renderer = { domElement: fake };
  }, 1500);
}

// ?assert=layout — the stability requirement, checked instead of eyeballed:
// toggling any control, opening a disclosure or taking a screenshot must not
// change ANY region's box. Only the viewport is flexible, so any change in it is
// a change in framing too (a resize re-fits the camera and the model jumps).
if (q.get('assert') === 'layout') {
  const panel = () => document.getElementById('root')?.firstElementChild as HTMLElement | undefined;
  const snap = () => Array.from(panel()?.children ?? [])
    // Absolutely-positioned children (the error toast) are overlays: they take no
    // space, so they cannot move anything and are not part of the layout budget.
    .filter((c) => getComputedStyle(c).position !== 'absolute')
    .map((c) => {
    const r = c.getBoundingClientRect();
    const t = (c.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 12);
    const viewport = !!c.querySelector('canvas, img[data-frozen], [data-scale]') || /WebGL/.test(c.textContent ?? '');
    return { t: `${viewport ? 'VIEWPORT' : 'chrome'} ${t}`, w: +r.width.toFixed(1), h: +r.height.toFixed(1), y: +r.y.toFixed(1) };
  });
  const diff = (a: ReturnType<typeof snap>, b: ReturnType<typeof snap>): string => {
    if (a.length !== b.length) return `child count ${a.length} -> ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      if (a[i]!.w !== b[i]!.w || a[i]!.h !== b[i]!.h || a[i]!.y !== b[i]!.y) {
        return `[${i}] ${a[i]!.t}: w ${a[i]!.w}->${b[i]!.w} h ${a[i]!.h}->${b[i]!.h} y ${a[i]!.y}->${b[i]!.y}`;
      }
    }
    return '';
  };
  const steps: [string, string][] = [
    ['测量', '测量'], ['壁厚', '壁厚'], ['剖切', '剖切'], ['参数', '参数'],
    ['⤢ 放大', '⤢'], ['⤡ 收回', '⤡'], ['截图', '截图'],
  ];
  // Chip widths inside the toolbar: they must not change with mode/badge state
  // either (a wider label would shift every chip after it).
  // The tool chips are icon-only now, so match on the tooltip (which names the
  // tool) rather than on the label text.
  // The background swatch: its position is exactly the thing being tuned, so
  // report it relative to the viewport instead of hunting for it in pixels.
  const bgPicker = () => {
    const el = document.querySelector('#root [data-bg-picker]') as HTMLElement | null;
    const vp = Array.from(document.querySelectorAll('#root div'))
      .find((d) => d.querySelector('canvas, img[data-frozen]'));
    if (!el) return '(absent)';
    const r = el.getBoundingClientRect();
    const v = vp?.getBoundingClientRect();
    return v
      ? `x=${Math.round(r.right - v.right)}(from right) y=${Math.round(r.top - v.top)} ${Math.round(r.width)}×${Math.round(r.height)}`
      : `${Math.round(r.width)}×${Math.round(r.height)}`;
  };
  const chipW = () => Array.from(document.querySelectorAll('#root button'))
    .filter((b) => /📸截图|□标注|📏测量|▤壁厚|◐剖切/.test(b.getAttribute('title') ?? ''))
    .map((b) => Math.round(b.getBoundingClientRect().width * 10) / 10);
  const run = async () => {
    const out: string[] = [];
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    const show = () => { pre.textContent = `layout stability (dock ${w}×${h})\n${out.join('\n')}`; };
    const base = snap();
    const baseChips = chipW();
    out.push(`baseline: ${base.map((c) => `${c.t.split(' ')[0]}=${c.w}x${c.h}`).join('  ')}`);
    out.push(`chips: ${baseChips.join(' ')}px`);
    out.push(`bg-picker: ${bgPicker()}`);
    show();
    for (const [label, text] of steps) {
      clickByText(text);
      await new Promise((r) => setTimeout(r, 70));
      const d = diff(base, snap());
      const cw = chipW();
      const cd = cw.length === baseChips.length && cw.every((x, i) => x === baseChips[i])
        ? '' : `chips ${baseChips.join('/')} -> ${cw.join('/')}`;
      out.push(`${d || cd ? 'FAIL' : 'PASS'}  after ${label.padEnd(4)}  ${[d, cd].filter(Boolean).join(' | ') || 'every region + chip identical'}`);
      show();   // incremental: a capture mid-run still shows the verdicts so far
    }

    // Reported bug: dragging (to orbit) in 壁厚 mode used to paint and commit an
    // annotation box. 标注 must still do exactly that — so this is a pair.
    const mount = document.querySelector('#root [style*="position: absolute"]') as HTMLElement | null;
    const viewportEl = mount?.parentElement ?? null;
    const annotationCount = () => Array.from(document.querySelectorAll('#root button'))
      .filter((b) => (b.textContent ?? '').includes('撤销标注')).length
      + Array.from(viewportEl?.querySelectorAll('div') ?? [])
        .filter((d) => (d as HTMLElement).style.border === '2px solid rgb(231, 76, 60)').length;
    const drag = async (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const opts = (x: number, y: number) => ({ bubbles: true, clientX: r.left + x, clientY: r.top + y, pointerId: 1 });
      el.dispatchEvent(new PointerEvent('pointerdown', opts(60, 60)));
      el.dispatchEvent(new PointerEvent('pointermove', opts(140, 120)));
      await new Promise((res) => setTimeout(res, 40));
      el.dispatchEvent(new PointerEvent('pointerup', opts(140, 120)));
      await new Promise((res) => setTimeout(res, 90));
    };
    if (mount) {
      clickByText('壁厚');
      await new Promise((res) => setTimeout(res, 110));
      const before = annotationCount();
      await drag(mount);
      const afterThick = annotationCount();
      out.push(afterThick === before
        ? `PASS  drag in 壁厚 mode created no annotation (${before} -> ${afterThick})`
        : `FAIL  drag in 壁厚 mode created an annotation (${before} -> ${afterThick})`);
      show();
      clickByText('壁厚');
      await new Promise((res) => setTimeout(res, 90));
      clickByText('标注');
      await new Promise((res) => setTimeout(res, 110));
      // In 标注 the handlers live on the overlay layer (it captures the pointer on
      // purpose, so the box drag does not orbit the camera) — a sibling of the
      // mount. Dispatching at the mount would never reach them.
      const annotLayer = document.querySelector('#root div[style*="z-index: 5"]') as HTMLElement | null;
      const beforeA = annotationCount();
      await drag(annotLayer ?? mount);
      const afterA = annotationCount();
      out.push(afterA > beforeA
        ? `PASS  the same drag in 标注 mode DID annotate (${beforeA} -> ${afterA})`
        : `FAIL  drag in 标注 mode did not annotate (${beforeA} -> ${afterA})`);
      clickByText('标注');
      await new Promise((res) => setTimeout(res, 90));
    }

    // The splitter is the one deliberate resize. ArrowUp x2 must move exactly the
    // body (+32) and the viewport (-32) and nothing else; Home restores auto.
    const grip = document.querySelector('#root [role="separator"]') as HTMLElement | null;
    if (grip) {
      const before = snap();
      // ArrowDown, not Up: the automatic split already sits at the upper limit
      // (viewer = square + VIEWPORT_AIR), so only shrinking has room to move.
      for (let i = 0; i < 2; i++) {
        grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
      }
      const after = snap();
      // The body sits directly after the strip, which is the row carrying the grip.
      const stripI = before.findIndex((c) => document.querySelectorAll('#root [role="separator"]').length > 0
        && c.t.startsWith('chrome') && /概览/.test(c.t));
      const bodyI = stripI + 1;
      const hDelta = (a: typeof before, b: typeof before) => a.map((c, i) => Math.round((b[i]!.h - c.h) * 10) / 10);
      const dh = hDelta(before, after);
      const vp = before.findIndex((c) => c.t.startsWith('VIEWPORT'));
      const others = dh.filter((_, i) => i !== vp && i !== bodyI);
      // ±2px tolerance: the body basis is an integer px but the flexed result is
      // rounded against the sibling's border box.
      const okSplit = Math.abs(dh[bodyI]! + 32) <= 2 && dh[vp] === -dh[bodyI]! && others.every((v) => v === 0);
      out.push(okSplit
        ? `PASS  splitter ArrowDown×2: body ${dh[bodyI]}, viewport +${dh[vp]}, others unchanged`
        : `FAIL  splitter ArrowDown×2: body ${dh[bodyI]}, viewport ${dh[vp]}, others ${others.join(',')}`);
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      out.push(diff(base, snap()) ? 'FAIL  Home did not restore the automatic split' : 'PASS  Home restored the automatic split');
      show();
    }
  };
  setTimeout(() => void run(), 1780);
}

if (q.get('debug') !== '0') {
  // Ground-truth layout probe, printed into the (visible) stage column.
  setTimeout(() => {
    const lines: string[] = [`dock ${w}×${h} dpr=${devicePixelRatio}`];
    const box = (label: string, el: Element | null) => {
      if (!el) { lines.push(`${label}: —`); return; }
      const r = el.getBoundingClientRect();
      lines.push(`${label}: x=${r.x.toFixed(0)} y=${r.y.toFixed(0)} w=${r.width.toFixed(0)} h=${r.height.toFixed(0)}`);
    };
    const rootEl = document.getElementById('root')?.firstElementChild ?? null;
    box('panel', rootEl);
    // Every direct child of the panel, in order: this is the vertical budget.
    // The viewport (stage) is the one holding a canvas, a frozen frame or the
    // no-WebGL card; everything else is chrome.
    if (rootEl) {
      Array.from(rootEl.children).forEach((c, i) => {
        const t = (c.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 16);
        const viewport = !!c.querySelector('canvas, img[data-frozen], [data-scale]')
          || /WebGL/.test(c.textContent ?? '');
        box(`  [${i}]${viewport ? ' VIEWPORT' : ''} "${t}"`, c);
      });
    }
    // How much content the fixed-height details box actually has to hide.
    const scrollers = Array.from(rootEl?.children ?? []).filter(
      (c) => (c as HTMLElement).scrollHeight > (c as HTMLElement).clientHeight + 1) as HTMLElement[];
    for (const [i, sc] of scrollers.entries()) {
      lines.push(`scroller[${i}]: client=${sc.clientHeight} scroll=${sc.scrollHeight} (+${sc.scrollHeight - sc.clientHeight}px hidden, ${(sc.scrollHeight / Math.max(1, sc.clientHeight)).toFixed(1)}x) "${(sc.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)}"`);
    }
    const ov = document.querySelector('#root [data-scale]') as HTMLElement | null;
    // The label's PARENT also matches the text regex, so require a leaf element.
    const scaleEl = Array.from(document.querySelectorAll('#root div'))
      .find((d) => d.children.length === 0 && /^[\d.]+ mm$/.test((d.textContent ?? '').trim()));
    const barEl = scaleEl?.previousElementSibling as HTMLElement | undefined;
    lines.push(`scale: ${ov?.dataset.scale ?? '—'} bar=${barEl ? Math.round(barEl.getBoundingClientRect().width) : '—'}px ppm=${ov?.dataset.ppm ?? '—'}`);
    const followBtn = document.querySelector('#root button[aria-label="跟随最新"], #root button[aria-label="已钉住"]');
    lines.push(`record picker: ${followBtn?.getAttribute('aria-label') ?? '—'} · ${(document.querySelectorAll('#root select')[1] as HTMLSelectElement | undefined)?.value ?? '—'}`);
    // Toolbar chips: their own widths must not change with mode/badge state.
    const chips = Array.from(document.querySelectorAll('#root button'))
      .filter((b) => /截图|标注|测量|壁厚|剖切/.test(b.textContent ?? ''));
    lines.push(`chips: ${chips.map((c) => `${(c.textContent ?? '').trim()}=${Math.round(c.getBoundingClientRect().width)}px`).join(' ')}`);
    const canvas = document.querySelector('#root canvas, #root img[data-frozen]');
    box('canvas', canvas);
    box('viewport', canvas?.parentElement?.parentElement ?? null);
    const stage = document.getElementById('stage');
    if (stage) {
      const pre = document.createElement('pre');
      pre.style.cssText = 'font:12px/1.5 monospace;white-space:pre;color:#111;align-self:flex-start;margin:12px;';
      pre.textContent = lines.join('\n');
      stage.textContent = '';
      stage.style.alignItems = 'flex-start';
      stage.appendChild(pre);
    }
  }, 2600);
}

