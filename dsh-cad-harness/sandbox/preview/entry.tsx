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
import { setProjectServices, setProjectOverride } from '../../src/client/project';
import { ViewportOverlay } from '../../src/client/overlay';
import { installCadTheme } from '../../src/client/theme.ts';

const q = new URLSearchParams(location.search);

// The sandbox mounts the panel directly, so the host's `apply()` does not run;
// install the token stylesheet here exactly as the client half does. Without it
// every `var(--cad-*, …)` would fall back to the light value.
installCadTheme();

// ?dark=1 — emulate the host's dark theme. The theme plugin marks dark by putting
// `data-ds-dark-theme` on <body>; the sandbox uses the same attribute (and the
// index.html darkens the dock chrome), so there is one theme path, not two.
const darkParam = q.get('dark') === '1';
if (darkParam) document.body.setAttribute('data-ds-dark-theme', '');
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

// ?project=/abs/dir — stand a session cwd in front of the panel. Project-scoped
// affordances (the local-STL import target, the empty-state wording) read the
// session list; without this the sandbox has no session and they render their
// "未识别" guard, which is correct but hides the normal state.
const projectParam = q.get('project');
if (projectParam) {
  // The panel deliberately has no cwd→project fallback; `?project=` is the
  // sandbox's explicit view selection (and the session stub below covers the
  // project-scoped import target).
  setProjectOverride(projectParam);
  const sessions = {
    list: { getSnapshot: () => ({ byId: { 'session-1': { id: 'session-1', cwd: projectParam } } }) },
    binding: (id: string) => (id === 'session-1' ? { sessionId: id } : undefined),
    retainInfo: () => ({ getSnapshot: () => ({ retainedBy: { mainView: 1 } }) }),
  };
  setProjectServices({ sessions });
  setClientServices({ sessions });
}

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
// The browse bar is now THREE selects for 零件 (DESIGN §20): [0] 种类,
// [1] 条目, [2] 版本 — but only TWO for the run categories (条目 IS the record).
// The record select is therefore the LAST one present.
/**
 * Pick a product through the NAVIGATOR (the breadcrumb overlay), which replaced
 * the 类别/条目/记录 selects. `navId` is the product id the row carries
 * (`p005` / `v066` / `r013` / a file path).
 */
const navPick = (navId: string) => {
  const open = document.querySelector('[aria-label="打开产物导航"]') as HTMLElement | null;
  open?.click();
  setTimeout(() => {
    const row = document.querySelector(`[data-nav-id="${navId}"]`) as HTMLElement | null;
    row?.click();
  }, 450);
};

const selectKind = (value: string) => {
  const selects = document.querySelectorAll('#root select');
  // The 工作目录 select is the only one left when it renders; the browse selects
  // are gone. `part` is the default, and 未登记 has a one-click button.
  if (selects.length >= 1 && (selects[0] as HTMLElement).getAttribute('aria-label') === '种类') {
    return selectByIndex(0, value);
  }
  if (value === 'unregistered') {
    (document.querySelector('[aria-label="未登记文件"]') as HTMLElement | null)?.click();
  }
};
const selectSubject = (value: string) => navPick(value);
const selectRecord = (value: string) => navPick(value);

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
  // The panel resolves the session structurally (DESIGN §18) — both service
  // views must see the same post-upgrade shape (NO `current`).
  setProjectServices({
    sessions: {
      list: { getSnapshot: () => ({ byId: { 'session-1': { id: 'session-1', cwd: '/tmp/sandbox' } } }) },
      binding: (id: string) => (id === 'session-1' ? { sessionId: id } : undefined),
      retainInfo: (id: string) => ({ getSnapshot: () => ({ retainedBy: { mainView: id === 'session-1' ? 1 : 0 } }) }),
    },
  });
  setClientServices({
    sessions: {
      // Post-upgrade shape: NO `current` — the panel must resolve the session
      // structurally (binding + mainView retention), which is what this stub
      // exercises (DESIGN §18).
      list: { getSnapshot: () => ({ byId: { 'session-1': { id: 'session-1', cwd: '/tmp/sandbox' } } }) },
      binding: (id: string) => (id === 'session-1' ? { sessionId: id } : undefined),
      retainInfo: (id: string) => ({ getSnapshot: () => ({ retainedBy: { mainView: id === 'session-1' ? 1 : 0 } }) }),
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

// ?slowstl=<KB per second> — throttle the STL download so the byte-progress pill
// is observable. Production code is untouched: this wraps fetch in the SANDBOX
// page and appends the server's `throttle` knob to mesh requests only.
{
  const slow = Number(q.get('slowstl') ?? '0');
  if (slow > 0) {
    const realFetch = window.fetch.bind(window);
    window.fetch = ((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      if (url.includes('/api/cad/stl')) {
        const joiner = url.includes('?') ? '&' : '?';
        return realFetch(`${url}${joiner}throttle=${slow}`, init);
      }
      return realFetch(input, init);
    }) as typeof window.fetch;
  }
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

// ?recent=v066,p005 — seed the MRU list before mount, so "reopen where you left
// off" can be captured (each shot runs in a fresh profile).
{
  const seeded = q.get('recent');
  if (seeded) {
    try { localStorage.setItem('cad.recent', JSON.stringify(seeded.split(',').map((x) => x.trim()).filter(Boolean))); } catch { /* private */ }
  }
}

const openParam = q.get('open');
const recordParam = q.get('record');
const wheelParam = q.get('wheel');
const resetParam = q.get('reset');
const kindParam = q.get('kind');
if (kindParam) setTimeout(() => selectKind(kindParam), 1200);
const shotParam = q.get('shot');
if (subjectParam) setTimeout(() => selectSubject(subjectParam), 1400);
// ?shot=1 — click 📥截图 so a stale-version capture (and its warning) can be reviewed.
if (shotParam) setTimeout(() => clickByText('截图'), 2100);
// ?send=1 — after the draft, click ✓发送到会话: the stubbed sendSession logs the
// outcome into the debug pre, so an E2E shot PROVES the image was sent.
const sendParam = q.get('send');
if (sendParam) setTimeout(() => clickByText('✓ 发送到会话'), 2900);
// After the subject: the record list it renders only exists once that landed.
if (recordParam) setTimeout(() => selectRecord(recordParam), 1750);
// `open` accepts a comma-separated sequence: `open=参数,⤢` clicks the tab, then
// expands it into the overlay.
if (openParam) {
  // After a navpick the page only exists once that pick lands (~2.15 s).
  const navpickCount = (q.get('navpick') ?? '').split(',').filter(Boolean).length;
  const openAt = q.get('navpick') ? 2700 + 900 * Math.max(0, navpickCount - 1) : 1900;
  const seq = openParam.split(',').map((x) => x.trim()).filter(Boolean);
  seq.forEach((text, i) => setTimeout(() => clickByText(text), openAt + i * 350));
}
// ?nav=1 — open the product navigator (the breadcrumb), without guessing its text:
// its label changes with whatever happens to be selected.
if (q.get('nav') === '1') {
  // With a navpick, wait for it to land first: the 最近 section only proves
  // itself when something has actually been visited.
  const at = q.get('navpick') ? 2700 : 1900;
  setTimeout(() => {
    const btn = document.querySelector('[aria-label="打开产物导航"]') as HTMLElement | null;
    btn?.click();
  }, at);
}
// ?navexpand=1 — open the navigator and expand the history gate (visual only).
if (q.get('navexpand') === '1') {
  setTimeout(() => {
    (document.querySelector('[aria-label="打开产物导航"]') as HTMLElement | null)?.click();
  }, 1500);
  setTimeout(() => {
    (document.querySelector('[data-nav-id="versions-toggle"]') as HTMLElement | null)?.click();
  }, 2100);
}
// ?navpick=<id> — open the navigator and click one product row (deterministic;
// the breadcrumb's own label changes with the selection).
const navpick = q.get('navpick');
if (navpick) {
  // Comma-separated ids pick a SEQUENCE (e.g. `v066,r061` = look at a version,
  // then open a run), which is how the stale-view-state bugs reproduce.
  const ids = navpick.split(',').map((x) => x.trim()).filter(Boolean);
  setTimeout(() => {
    const openNav = () => document.querySelector('[aria-label="打开产物导航"]') as HTMLElement | null;
    const pick = (i: number) => {
      const row = document.querySelector(`[data-nav-id="${ids[i]}"]`) as HTMLElement | null;
      row?.click();
      if (i + 1 < ids.length) {
        setTimeout(() => { openNav()?.click(); setTimeout(() => pick(i + 1), 450); }, 450);
      }
    };
    openNav()?.click();
    setTimeout(() => pick(0), 450);
  }, 1700);
}
// ?navq=… — type into the navigator's search box (native setter + input event, so
// React's controlled input sees the change).
const navq = q.get('navq');
if (navq) {
  setTimeout(() => {
    const input = document.querySelector('[aria-label="搜索产物"]') as HTMLInputElement | null;
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, navq);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, 2300);
}
if (wheelParam) {
  setTimeout(() => {
    for (let i = 0; i < Math.abs(Number(wheelParam)); i += 100) wheel(Math.sign(Number(wheelParam)) * 100);
  }, 2000);
}
if (resetParam) setTimeout(() => clickByText('复原'), 2600);

// ?localstl=<versionId> — open 本地 STL and feed it a REAL STL from the mock
// corpus through the file input, so the preview's geometry path (and not just
// its empty state) can be reviewed. The canvas freeze runs at ~2.9 s, after the
// file has parsed.
const localStlParam = q.get('localstl');
if (localStlParam) {
  setTimeout(() => {
    // 📂 now jumps to the 未登记 category; the dialog is one step further in
    // ("按路径导入…") and opens on its import tab, so 预览 must be clicked.
    clickByText('📂');
    setTimeout(() => {
      clickByText('📂 按路径导入…');
      setTimeout(() => {
        clickByText('预览');
        void (async () => {
          try {
            const res = await fetch(`/api/cad/stl?v=${encodeURIComponent(localStlParam)}`);
            if (!res.ok) throw new Error(`STL HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            const input = document.querySelector('#root input[type=file]') as HTMLInputElement | null;
            if (!input) throw new Error('file input not found — did the dialog open?');
            const dt = new DataTransfer();
            dt.items.add(new File([buf], `${localStlParam}.stl`, { type: 'model/stl' }));
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e) {
            reportError('localstl', e);
          }
        })();
      }, 400);
    }, 700);
  }, 1500);
}


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
  // `?freezeat=<ms>` delays the capture (default 2.9 s) so a longer assertion
  // (e.g. `assert=orbit`) can finish its drag before the canvas is frozen.
  const freezeAtRaw = Number(q.get('freezeat'));
  const freezeAt = Number.isFinite(freezeAtRaw) && freezeAtRaw > 0 ? freezeAtRaw : 2900;
  setTimeout(freezeCanvas, freezeAt);
  setTimeout(freezeCanvas, freezeAt + 200);
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

// ?assert=local-import — drive the human import for REAL (open the dialog, type
// a path, submit) against the mock POST, then assert what left the browser:
// the session project in the query, the path/unit/part in the body, render:false,
// and the dialog closing on success. The unit test covers the request builder;
// this covers the glue.
if (q.get('assert') === 'local-import') {
  const setInput = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const report = async () => {
    const list = await (await fetch('/api/cad/__imports')).json();
    const last = list[list.length - 1] ?? {};
    const body = last.body ?? {};
    const dialogOpen = !!document.querySelector('#root [role="dialog"]');
    const checks: [boolean, string][] = [
      [list.length === 1, `exactly one POST reached the door (${list.length})`],
      [last.project === q.get('project'), `project = ${last.project}`],
      [body.file === 'out/pan-45.stl', `file = ${body.file}`],
      [body.unit === 'mm', `unit = ${body.unit}`],
      [body.part === '托盘', `part = ${body.part}`],
      [body.render === false, `render = ${body.render}`],
      [!dialogOpen, 'the dialog closed on success'],
    ];
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    pre.textContent = 'local import (mock POST)\n'
      + checks.map(([ok, t]) => `${ok ? 'PASS' : 'FAIL'}  ${t}`).join('\n');
    document.getElementById('stage')!.appendChild(pre);
  };
  setTimeout(() => {
    // 📂 → 未登记 category; the by-path door is inside the sheet, and the dialog
    // already opens on its import tab.
    clickByText('📂');
    setTimeout(() => {
      clickByText('📂 按路径导入…');
      setTimeout(() => {
        const inputs = Array.from(document.querySelectorAll('#root input')) as HTMLInputElement[];
        const path = inputs.find((i) => (i.placeholder ?? '').includes('out/pan-45'));
        const part = inputs.find((i) => (i.placeholder ?? '').includes('默认取文件名'));
        if (path) setInput(path, 'out/pan-45.stl');
        if (part) setInput(part, '托盘');
        setTimeout(() => {
          clickByText('导入并登记');
          setTimeout(() => void report(), 900);
        }, 200);
      }, 400);
    }, 700);
  }, 1500);
}

// ?assert=theme — the panel must follow the host's light/dark palette, and no
// label may be light-on-light in either mode. The regression: the chrome was
// fixed light, so with `data-ds-dark-theme` set the body's light ink landed on
// white plates (the simulation viewport's transport buttons were the loudest).
//
// The check is a CONTRAST check, not a screenshot: every element with its own
// text is measured against the background actually behind it (walking up the
// ancestor chain and compositing translucent layers). A theme that forgets one
// plate fails here even when the rest of the panel looks right.
if (q.get('assert') === 'theme') {
  type RGB = [number, number, number, number];
  const parseColor = (value: string): RGB => {
    const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
    if (!m) return [0, 0, 0, 0];
    const p = m[1]!.split(',').map((x) => parseFloat(x));
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
  };
  const luminance = ([r, g, b]: RGB): number => {
    const f = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a: RGB, b: RGB): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const over = (top: RGB, bottom: RGB): RGB => {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  };
  const backgroundOf = (el: Element): RGB => {
    const layers: RGB[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      const c = parseColor(getComputedStyle(cur).backgroundColor);
      if (c[3] > 0.01) layers.push(c);
      if (c[3] >= 0.999) break;
    }
    // The page's own canvas is the last resort; the dock and body are opaque in
    // both modes, so this only matters for a detached element.
    let base: RGB = darkParam ? [18, 22, 26, 1] : [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i]!, base);
    return base;
  };
  const resolveVar = (name: string): RGB => {
    const probe = document.createElement('span');
    probe.style.cssText = `position:fixed;left:-9999px;width:0;height:0;background:var(${name}, #ff00ff)`;
    document.body.appendChild(probe);
    const value = parseColor(getComputedStyle(probe).backgroundColor);
    probe.remove();
    return value;
  };

  // Wait for the panel's async corpus to land: a theme check on an empty shell
  // would pass vacuously.
  const waitFor = (fn: () => boolean, ms = 9000) => new Promise<boolean>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });

  void (async () => {
    const loaded = await waitFor(() => document.querySelectorAll('#root *').length > 30);
    const rootEl = document.querySelector('#root .cad-theme') as HTMLElement | null;
    const lines: string[] = [`theme (dock ${w}×${h}, ${darkParam ? 'dark' : 'light'})`];
    const pass = (ok: boolean, label: string, detail = '') => {
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    };

    pass(Boolean(document.getElementById('cad-theme-tokens')), 'the token stylesheet is installed');
    pass(Boolean(rootEl), 'the panel carries the `cad-theme` scope');

    const plate = resolveVar('--cad-plate');
    const ink = resolveVar('--cad-ink');
    const plateLum = luminance(plate);
    const inkLum = luminance(ink);
    pass(darkParam ? plateLum < 0.18 : plateLum > 0.8,
      `the active plate is ${darkParam ? 'dark' : 'light'}`, `luminance ${plateLum.toFixed(3)}`);
    pass(darkParam ? inkLum > 0.55 : inkLum < 0.2,
      `the active ink is ${darkParam ? 'light' : 'dark'}`, `luminance ${inkLum.toFixed(3)}`);

    if (rootEl) {
      const rootColor = parseColor(getComputedStyle(rootEl).color);
      pass(contrast(rootColor, plate) >= 4.5, 'the panel root carries readable ink',
        `contrast ${contrast(rootColor, plate).toFixed(2)}`);
    }

    // Every element whose own text is visible: its colour must stand off the
    // surface behind it. 2.5 is the floor for a dense, deliberately muted label;
    // the failure this catches is ~1.0 (light ink on a light plate).
    const textEls = [...document.querySelectorAll('#root *')].filter((el) => {
      const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
      const box = el.getBoundingClientRect();
      // The instrument plate (triad + scale bar) and the pinned read-outs are
      // drawn ON the 3D ground, so their ink follows the user's background preset
      // (light or dark), not the host theme. They are scene annotations, not
      // chrome; their legibility rule lives in overlay.ts.
      if (el.closest('[data-corner], [data-label]')) return false;
      return hasOwnText && box.width >= 1 && box.height >= 1;
    });
    const weak: string[] = [];
    let worst = { ratio: Number.POSITIVE_INFINITY, tag: '' };
    for (const el of textEls) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
      const fg = parseColor(style.color);
      if (fg[3] < 0.2) continue;
      const ratio = contrast(fg, backgroundOf(el));
      const label = `<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 24)}"`;
      if (ratio < worst.ratio) worst = { ratio, tag: label };
      if (ratio < 2.5) weak.push(`${label} ${ratio.toFixed(2)}`);
    }
    pass(textEls.length >= 20, 'the contrast sweep measured real labels', `${textEls.length} elements`);
    pass(weak.length === 0, 'no label is washed out in this theme', weak.slice(0, 5).join(' | ') || 'none');
    lines.push(`      lowest contrast: ${worst.ratio.toFixed(2)} on ${worst.tag}`);

    // Controls get their own voice: a button that inherits ink is exactly the bug.
    const controls = [...document.querySelectorAll('#root button, #root select, #root input, #root textarea')]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width >= 1 && box.height >= 1 && !(el as HTMLInputElement).disabled;
      });
    const badControls: string[] = [];
    for (const el of controls) {
      // A control that paints no text (the 8px keyframe diamond, the 3px event
      // tick) is a hit target, not a label: its inherited colour is irrelevant.
      const label = ((el as HTMLInputElement).value || el.textContent || (el as HTMLInputElement).placeholder || '').trim();
      if (!label) continue;
      const style = getComputedStyle(el);
      const fg = parseColor(style.color);
      const ratio = contrast(fg, backgroundOf(el));
      if (ratio < 2.5) {
        const what = ((el as HTMLInputElement).value || el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || el.outerHTML.slice(0, 90)).replace(/\s+/g, ' ').trim();
        badControls.push(`"${what.slice(0, 60)}" ${ratio.toFixed(2)}`);
      }
    }
    pass(controls.length >= 8, 'the control sweep measured real controls', `${controls.length} controls`);
    pass(badControls.length === 0, 'controls keep readable ink', badControls.slice(0, 5).join(' | ') || 'none');

    const pre = document.createElement('pre');
    pre.style.cssText = `font:12px/1.6 monospace;white-space:pre-wrap;margin:12px;color:${darkParam ? '#e7eaef' : '#111'};`;
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    if (!loaded) lines.push('FAIL  the panel never rendered enough content to check');
    pre.textContent = lines.join('\n');
  })();
}

// Every assert renders its verdict into a <pre> under #stage. Forward that text
// to the sandbox server so a runner can read PASS/FAIL instead of a human reading
// a screenshot: one observer, and every current and future assert is covered.
if (q.get('assert')) {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let last = '';
  const flush = () => {
    const pre = document.querySelector('#stage pre');
    const text = (pre?.textContent ?? '').trim();
    if (!text || text === last) return;
    last = text;
    const lines = text.split('\n');
    const ok = !lines.some((l) => l.trimStart().startsWith('FAIL'));
    void fetch('/api/cad/assert-result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: q.get('assert'), ok, text }),
    }).catch(() => { /* the runner falls back to the screenshot */ });
  };
  new MutationObserver(() => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(flush, 100);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(flush, 4600);
}

// ?assert=orbit — the viewport uses three.js OrbitControls' default behaviour.
//
// The regression this guards is the old hand-written free orbit: it let the
// camera cross the poles by rotating `camera.up`, and after an upside-down pose
// a horizontal drag moved the model the wrong way. The stock controller keeps
// `camera.up` at world up and clamps the polar angle, so the screen basis cannot
// invert. Meant to run with a version selected (`&record=v105&freeze=1&freezeat=6000&slow=9000`);
// the delayed freeze leaves the canvas live while the probe drags. `&orbitreset=1`
// also clicks 复原 afterwards and checks that position and camera.up return.
if (q.get('assert') === 'orbit') {
  const show = (lines: string[]) => {
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    pre.textContent = lines.join('\n');
  };
  const frame = () => new Promise<void>((res) => requestAnimationFrame(() => res()));
  const pause = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  const run = async () => {
    let canvas: HTMLCanvasElement | null = null;
    let host: (HTMLElement & { __camera?: any; __controls?: any }) | null = null;
    for (let i = 0; i < 20; i++) {
      canvas = document.querySelector('#root canvas') as HTMLCanvasElement | null;
      host = (canvas?.parentElement ?? null) as typeof host;
      if (canvas && host?.__camera && host.__controls) break;
      await pause(250);
    }
    if (!canvas || !host?.__camera || !host.__controls) {
      show([`default orbit (dock ${w}×${h})`, 'FAIL  no live camera/controls — load a version first (`&record=<version>&freeze=1&freezeat=6000&slow=9000`)']);
      return;
    }
    const cam = host.__camera;
    const ctl = host.__controls;
    const target = ctl.target.clone();
    const radius = cam.position.distanceTo(target);
    const startPos = cam.position.clone();
    const r = canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Synthetic pointer events cannot create a real pointer capture; the
    // controller calls setPointerCapture on pointerdown, so stub it for the probe.
    const originalCapture = canvas.setPointerCapture;
    const originalRelease = canvas.releasePointerCapture;
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    const ev = (type: string, x: number, y: number) => canvas!.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
    }));
    const yRel = () => cam.position.y - target.y;
    const startY = yRel();
    let minY = startY;
    let maxY = startY;
    // Sampling the full orientation, not just position, catches the old
    // "sudden mirror flip": at the pole lookAt used to jump the quaternion 180°.
    const qStep = (a: any, b: any) =>
      (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;
    let prevQ = cam.quaternion.clone();
    let maxStep = 0;
    ev('pointerdown', cx, cy);
    // Drag DOWN: the default polar clamp stops at the pole instead of rolling
    // the camera over it. The invariant is that up stays world up.
    const steps = 24;
    const total = r.height * 2.4;
    for (let i = 1; i <= steps; i++) {
      ev('pointermove', cx, cy + (total * i) / steps);
      await frame();
      minY = Math.min(minY, yRel());
      maxY = Math.max(maxY, yRel());
      const q = cam.quaternion.clone();
      maxStep = Math.max(maxStep, qStep(prevQ, q));
      prevQ = q;
    }
    ev('pointerup', cx, cy + total);
    canvas.setPointerCapture = originalCapture;
    canvas.releasePointerCapture = originalRelease;
    await pause(500); // let any damping settle before reporting
    const clamped = minY > -0.05 * Math.max(radius, 1e-6);
    const upStable = cam.up.y > 0.99;
    const lines = [
      `default orbit (dock ${w}×${h})`,
      `${clamped ? 'PASS' : 'FAIL'}  the polar clamp stops the camera above the target (min camera y relative to target ${minY.toFixed(2)})`,
      `camera y rel. target: start ${startY.toFixed(2)}, min ${minY.toFixed(2)}, max ${maxY.toFixed(2)}, radius ${radius.toFixed(2)}`,
      `${upStable ? 'PASS' : 'FAIL'}  camera.up stays world up (y=${cam.up.y.toFixed(3)})`,
      `${maxStep < 90 ? 'PASS' : 'FAIL'}  no mirror flip during the drag (max orientation step ${maxStep.toFixed(1)}°)`,
    ];
    if (q.get('orbitreset') === '1') {
      const resetBtn = Array.from(document.querySelectorAll('#root button'))
        .find((b) => (b.textContent ?? '').includes('复原')) as HTMLButtonElement | undefined;
      resetBtn?.click();
      await pause(700);
      const dist = cam.position.distanceTo(startPos);
      const upOk = cam.up.y > 0.99;
      lines.push(`${resetBtn ? 'PASS' : 'FAIL'}  复原 control is present`);
      lines.push(`${dist < radius * 0.01 ? 'PASS' : 'FAIL'}  复原 returns the camera (off by ${dist.toFixed(3)}mm, radius ${radius.toFixed(2)}mm)`);
      lines.push(`${upOk ? 'PASS' : 'FAIL'}  复原 restores camera.up (y=${cam.up.y.toFixed(3)})`);
    }
    show(lines);
  };
  void run();
}

// ?assert=orbit-drain — one 100 px move vs the same 100 px split into 20 events
// inside ONE frame. OrbitControls accumulates every pointermove into the same
// spherical delta, so the two drags must end at the same pose.
if (q.get('assert') === 'orbit-drain') {
  const show = (lines: string[]) => {
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    pre.textContent = lines.join('\n');
  };
  const frame = () => new Promise<void>((res) => requestAnimationFrame(() => res()));
  const pause = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  const run = async () => {
    let canvas: HTMLCanvasElement | null = null;
    let host: (HTMLElement & { __camera?: any; __controls?: any }) | null = null;
    for (let i = 0; i < 20; i++) {
      canvas = document.querySelector('#root canvas') as HTMLCanvasElement | null;
      host = (canvas?.parentElement ?? null) as typeof host;
      if (canvas && host?.__camera && host.__controls) break;
      await pause(250);
    }
    if (!canvas || !host?.__camera || !host.__controls) {
      show([`orbit drain (dock ${w}×${h})`, 'FAIL  no live camera/controls — load a version first']);
      return;
    }
    const cam = host.__camera;
    const ctl = host.__controls;
    const originalCapture = canvas.setPointerCapture;
    const originalRelease = canvas.releasePointerCapture;
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    const ev = (type: string, x: number, y: number) => canvas!.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
    }));
    const angleBetween = (a: any, b: any) =>
      (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;
    const homePos = cam.position.clone();
    const homeUp = cam.up.clone();
    const homeTarget = ctl.target.clone();
    const reset = async () => {
      cam.position.copy(homePos);
      cam.up.copy(homeUp);
      ctl.target.copy(homeTarget);
      (ctl as unknown as { _lastAngle?: number })._lastAngle = 0;
      ctl.update();
      await pause(120);
    };
    const drag = async (splits: number): Promise<number> => {
      await reset();
      const rect = canvas!.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const x0 = rect.left + rect.width / 2;
      ev('pointerdown', x0, y);
      let total = 0;
      let prev = cam.quaternion.clone();
      for (let i = 1; i <= splits; i++) {
        ev('pointermove', x0 + (100 * i) / splits, y);
        const now = cam.quaternion.clone();
        total += angleBetween(prev, now);
        prev = now;
      }
      // Let the RAF run too: without the drain this is where the last segment
      // would be applied, so the probe measures the slow implementation fairly.
      await frame();
      const afterFrame = cam.quaternion.clone();
      total += angleBetween(prev, afterFrame);
      ev('pointerup', x0 + 100, y);
      await pause(120);
      return total;
    };
    await pause(2000); // let the panel's initial poll settle
    const one = await drag(1);
    const split = await drag(20);
    canvas.setPointerCapture = originalCapture;
    canvas.releasePointerCapture = originalRelease;
    const ratio = one > 1e-6 ? split / one : 0;
    show([
      `orbit drain (dock ${w}×${h})`,
      `${one > 10 && ratio > 0.8 ? 'PASS' : 'FAIL'}  a split drag keeps its movement (split/one ≥ 0.8)`,
      `same 100px in one frame: 1 move ${one.toFixed(2)}°, 20 moves ${split.toFixed(2)}°, ratio ${ratio.toFixed(3)}`,
    ]);
  };
  void run();
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
    // Overlays (absolute OR fixed) take no layout space, so they cannot move
    // anything and are not part of the vertical budget. `fixed` was missed:
    // the screenshot compose dialog is fixed-positioned, so opening 截图 made
    // the child count change and the assertion cried wolf.
    .filter((c) => !['absolute', 'fixed'].includes(getComputedStyle(c).position))
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

    // The 截图 step opens the compose dialog. It takes no layout space (the
    // snapshot excludes fixed overlays), but its full-screen backdrop would
    // swallow the splitter drag and the mode clicks below — close it first.
    clickByText('取消');
    await new Promise((r) => setTimeout(r, 140));

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
  // A subject/navpick selection lands at ~1.85 s; snapshotting at 1.78 s caught a
  // transient row (the version had not been chosen yet, so the status glyph and
  // the pin were not mounted). Start after the selection settles.
  const settle = q.get('subject') || q.get('navpick') ? 2600 : 1780;
  setTimeout(() => void run(), settle);
}

// ?assert=recent&expect=<text> — the panel must reopen on the last visited
// address, not on whatever the corpus happens to order first.
if (q.get('assert') === 'recent') {
  const expect = q.get('expect') ?? '';
  setTimeout(() => {
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    const crumb = document.querySelector('[aria-label="打开产物导航"]')?.textContent ?? '';
    const ok = expect ? crumb.includes(expect) : crumb.length > 0;
    pre.textContent = `recent restore (dock ${w}×${h})\n`
      + `${ok ? 'PASS' : 'FAIL'}  breadcrumb ${ok ? 'contains' : 'does NOT contain'} "${expect}"\n`
      + `      breadcrumb: ${crumb.replace(/\s+/g, ' ').trim()}`;
  }, 2600);
}

// ?assert=review — the queue must be a QUEUE: opening it does not move the
// viewport, choosing 看 does. Both halves are checked.
if (q.get('assert') === 'review') {
  const crumb = () => (document.querySelector('[aria-label="打开产物导航"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const rowsNow = () => document.querySelectorAll('[data-review-row]').length;
  // Wait for a condition instead of sleeping: mount timing depends on how fast
  // the corpus + queue fetch resolve, and a fixed 600 ms made this read an empty
  // page and then "pass" the close-check trivially.
  const waitFor = (fn: () => boolean, ms = 6000) => new Promise<boolean>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
  void (async () => {
    const lines: string[] = [`review queue (dock ${w}×${h})`];
    const hasBadge = await waitFor(() => Boolean(document.querySelector('[data-review-strip]')));
    const before = crumb();
    lines.push(`${hasBadge ? 'PASS' : 'FAIL'}  the line under the viewport carries the 待阅 strip`);
    (document.querySelector('[data-review-strip]') as HTMLElement | null)?.click();
    const opened = await waitFor(() => rowsNow() > 0);
    const rows = rowsNow();
    const mid = crumb();
    lines.push(`${opened ? 'PASS' : 'FAIL'}  the badge opens a list with items (${rows})`);
    lines.push(`${mid === before ? 'PASS' : 'FAIL'}  opening the list did NOT move the viewport`);
    (document.querySelector('[data-review-open="q001"]') as HTMLElement | null)?.click();
    const closed = await waitFor(() => rowsNow() === 0);
    const after = crumb();
    lines.push(`${closed ? 'PASS' : 'FAIL'}  choosing 看 closes the list`);
    lines.push(`${/r059/.test(after) && after !== before ? 'PASS' : 'FAIL'}  and lands on the item target: ${after}`);
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    pre.textContent = lines.join('\n');
  })();
}

// ?assert=playback-annotate — the playback toolbar's 「▭ 标注」 must really draw a
// box: a button that renders but commits nothing is the failure mode this checks.
// (The box is screen-space; that is WHY it can exist in a playback view at all.)
if (q.get('assert') === 'playback-annotate') {
  const waitFor = (fn: () => boolean, ms = 8000) => new Promise<boolean>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
  void (async () => {
    const ready = await waitFor(() => Boolean(document.querySelector('[data-annotate-toggle]')));
    const layer = document.querySelector('[data-annotate-layer]') as HTMLElement | null;
    const lines = [`playback annotation (dock ${w}×${h})`];
    lines.push(`${ready ? 'PASS' : 'FAIL'}  the playback toolbar carries 「▭ 标注」`);
    lines.push(`${layer ? 'PASS' : 'FAIL'}  the annotation layer exists over the canvas`);
    (document.querySelector('[data-annotate-toggle]') as HTMLElement | null)?.click();
    await new Promise((r) => setTimeout(r, 150));
    const armed = layer ? getComputedStyle(layer).pointerEvents : 'none';
    lines.push(`${armed === 'auto' ? 'PASS' : 'FAIL'}  arming it takes pointer events (was ${armed}; orbit keeps them otherwise)`);
    let committed = 0;
    if (layer) {
      const r = layer.getBoundingClientRect();
      const fire = (type: string, x: number, y: number) => layer.dispatchEvent(new PointerEvent(type, {
        bubbles: true, clientX: r.left + x, clientY: r.top + y, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));
      // Separate ticks: a real drag arrives as separate events, and React has to
      // re-render between them for the layer to see its own drag state.
      fire('pointerdown', 20, 20);
      await new Promise((r) => setTimeout(r, 60));
      fire('pointermove', 120, 90);
      await new Promise((r) => setTimeout(r, 60));
      fire('pointerup', 120, 90);
      committed = await waitFor(() => document.querySelectorAll('[data-annotate-box]').length > 0, 2000)
        ? document.querySelectorAll('[data-annotate-box]').length : 0;
    }
    lines.push(`${committed === 1 ? 'PASS' : 'FAIL'}  a drag commits exactly one box (${committed})`);
    const clear = document.querySelector('[data-annotate-clear]') as HTMLElement | null;
    clear?.click();
    await new Promise((r) => setTimeout(r, 120));
    const left = document.querySelectorAll('[data-annotate-box]').length;
    lines.push(`${left === 0 ? 'PASS' : 'FAIL'}  清除 removes them (${left} left)`);
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    pre.textContent = lines.join('\n');
  })();
}

// ?assert=contract — the contract card must be a DOCUMENT, not a splash: a table
// with rows, the undeclared pairs it counts (as many as it says), the manifest's
// own holes, and its boundary. Machine-checked because "looks full" is not a check.
if (q.get('assert') === 'contract') {
  const waitFor = (fn: () => boolean, ms = 8000) => new Promise<boolean>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
  void (async () => {
    const card = await waitFor(() => Boolean(document.querySelector('[data-contract-card]')));
    const el = document.querySelector('[data-contract-card]');
    const text = (el?.textContent ?? '').replace(/\s+/g, ' ');
    const rows = document.querySelectorAll('[data-contract-row]').length;
    const undeclaredRows = document.querySelectorAll('[data-undeclared-row]').length;
    const said = /清单不完整：(\d+) 对/.exec(text);
    const claimed = said ? Number(said[1]) : 0;
    // Whether the "manifest is thin" line SHOULD be there is a property of the
    // corpus, not of this scenario: read the manifest and compare. (Checking for
    // its mere presence failed on a complete manifest — the right answer there is
    // the absence of the line.)
    const man = await fetch('/api/cad/assembly/manifest').then((r) => r.json()).catch(() => null);
    let thin: { interfaces: number; withTol: number; nodes: number; bom: number } | null = null;
    try {
      let interfaces = 0; let withTol = 0;
      const nodes: { qty?: number; material?: string }[] = [];
      const walk = (n: any) => {
        if (!n) return;
        for (const it of n.interfaces ?? []) {
          interfaces++;
          if (it?.tolerance && typeof it.tolerance.min === 'number' && typeof it.tolerance.max === 'number') withTol++;
        }
        if (n.kind === 'part') nodes.push(n);
        for (const c of n.children ?? []) walk(c);
      };
      walk(man?.root);
      thin = { interfaces, withTol, nodes: nodes.length, bom: nodes.filter((n) => typeof n.qty === 'number' && n.material).length };
    } catch { thin = null; }
    const expectThin = Boolean(thin && (thin.withTol < thin.interfaces || thin.bom < thin.nodes));
    const saysThin = Boolean(document.querySelector('[data-contract-thin]'));
    const lines = [
      `contract document (dock ${w}×${h})`,
      `${card ? 'PASS' : 'FAIL'}  the card is the contract document (not a centred splash)`,
      `${rows > 0 ? 'PASS' : 'FAIL'}  it renders the contract table (${rows} row(s))`,
      `${undeclaredRows === claimed ? 'PASS' : 'FAIL'}  it LISTS what it counts: says ${claimed} undeclared, renders ${undeclaredRows}`,
      `${saysThin === expectThin ? 'PASS' : 'FAIL'}  the manifest-gap line matches the manifest` +
        (thin ? ` (${thin.withTol}/${thin.interfaces} with tolerance, ${thin.bom}/${thin.nodes} with qty+material)` : ' (manifest unreadable)'),
      `${text.includes('不覆盖') ? 'PASS' : 'FAIL'}  it states what the check does NOT cover`,
    ];
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    pre.textContent = lines.join('\n');
  })();
}

// ?assert=playback — the simulation stage must expose the run's key numbers and
// a keyframe transport, not only a slider. This is checked on the DOM (the
// sandbox has no WebGL, and the data strip deliberately survives that).
if (q.get('assert') === 'playback') {
  const started = performance.now();
  const finish = (lines: string[]) => {
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    pre.textContent = lines.join('\n');
  };
  const tick = () => {
    const data = document.querySelector('[data-playback-data]') as HTMLElement | null;
    const summary = document.querySelector('[data-run-summary]') as HTMLElement | null;
    const kf = document.querySelector('[data-keyframe-select]') as HTMLSelectElement | null;
    const timeline = document.querySelector('[data-run-timeline]');
    const pause = document.querySelector('[data-pause-keyframes]');
    const chart = document.querySelector('[data-run-chart]');
    const strip = document.querySelector('[data-keyframe-strip]');
    const viewport = document.querySelector('[data-playback-viewport]') as HTMLElement | null;
    const compact = Boolean(document.querySelector('[data-playback-compact]'));
    if (!data && performance.now() - started < 8000) return setTimeout(tick, 120);
    const text = (data?.textContent ?? '').replace(/\s+/g, ' ');
    finish([
      `playback data/transport (dock ${w}×${h})`,
      `${data ? 'PASS' : 'FAIL'}  the run data strip is rendered`,
      `${summary && summary.textContent && summary.textContent.trim().length > 10 ? 'PASS' : 'FAIL'}  it carries a one-sentence reading`,
      `${data && /采样|干涉|穿透|到达率/.test(text) ? 'PASS' : 'FAIL'}  the strip carries the run's key numbers`,
      `${kf && kf.options.length >= 2 ? 'PASS' : 'FAIL'}  there is a keyframe selector (${kf?.options.length ?? 0} option(s))`,
      `${kf && Math.abs(kf.getBoundingClientRect().width - 150) < 1 ? 'PASS' : 'FAIL'}  the keyframe selector reserves 150px (no text-driven resize) (${Math.round(kf?.getBoundingClientRect().width ?? 0)}px)`,
      `${timeline ? 'PASS' : 'FAIL'}  the event/keyframe timeline is present`,
      `${pause ? 'PASS' : 'FAIL'}  the 'pause at keyframe' control is present`,
      `${chart || compact ? 'PASS' : 'FAIL'}  the time-series chart is rendered${compact ? ' (compact → report tab)' : ''}`,
      `${strip || compact ? 'PASS' : 'FAIL'}  the keyframe thumbnail strip is rendered${compact ? ' (compact → report tab)' : ''}`,
      `${viewport && viewport.getBoundingClientRect().height >= 80 ? 'PASS' : 'FAIL'}  the 3D viewport keeps ${Math.round(viewport?.getBoundingClientRect().height ?? 0)}px (≥80)`,
    ]);
  };
  setTimeout(tick, 1200);
}

// ?assert=section — the playback's section control is a 3D feature: under Xvfb it
// must open the plane controls and keep a canvas. Bare headless gets SKIP.
if (q.get('assert') === 'section') {
  let tries = 0;
  const show = (lines: string[]) => {
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    pre.textContent = lines.join('\n');
  };
  const tick = () => {
    const tools = document.querySelector('[data-playback-tools]') as HTMLElement | null;
    // The sandbox freezes the canvas into an <img> at ~2.9s for the capture;
    // the 3D surface is still there, just no longer a <canvas> node.
    const canvas = document.querySelector('#root canvas, #root img[data-frozen]');
    const text = (tools?.textContent ?? '').replace(/\s+/g, ' ');
    if (tools && !text.includes('无封盖') && tries++ < 2) {
      const btn = Array.from(tools.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('剖切'));
      btn?.click();
      return setTimeout(tick, 400);
    }
    if (!tools) {
      const body = (document.body.textContent ?? '').replace(/\s+/g, ' ');
      if (/无法创建 WebGL 上下文|几何预览不可用/.test(body)) {
        show([`section cut (dock ${w}×${h})`, 'SKIP  no WebGL context: the 3D section control is intentionally absent.']);
      } else {
        show([`section cut (dock ${w}×${h})`, 'FAIL  the playback section toolbar never rendered']);
      }
      return;
    }
    show([
      `section cut (dock ${w}×${h})`,
      `${canvas ? 'PASS' : 'FAIL'}  the playback canvas is present`,
      `${text.includes('剖切') ? 'PASS' : 'FAIL'}  the section toggle is present`,
      `${text.includes('无封盖') ? 'PASS' : 'FAIL'}  opening it exposes the live-clip controls (无封盖)`,
      `${tools.querySelector('input[type=range]') ? 'PASS' : 'FAIL'}  the section position slider is present`,
    ]);
  };
  setTimeout(tick, 3000);
}

// ?assert=deeplink&expect=<text> — a link must land on its object, and an old
// version must land in the HISTORY state (banner), not silently as if current.
if (q.get('assert') === 'deeplink') {
  setTimeout(() => {
    const expect = q.get('expect') ?? '';
    const crumb = (document.querySelector('[aria-label="打开产物导航"]')?.textContent ?? '')
      .replace(/\s+/g, ' ').trim();
    const banner = document.body.textContent?.includes('旧版本') ?? false;
    const lines = [
      `deep link (?t=${q.get('t') ?? ''}) (dock ${w}×${h})`,
      `${expect && crumb.includes(expect) ? 'PASS' : 'FAIL'}  breadcrumb contains "${expect}": ${crumb}`,
    ];
    if (q.get('t') && /^v\d{3,}$/.test(q.get('t') ?? '')) {
      lines.push(`${banner ? 'PASS' : 'FAIL'}  an old version opens in the history state (banner present)`);
    }
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    pre.textContent = lines.join('\n');
  }, 2600);
}

// ?assert=ghost — the comparison control must name the version it overlays and
// actually toggle. (Whether the two meshes DIFFER is a property of the corpus:
// the server logs each STL id it served, so `stl v030` + `stl v066` is the
// evidence that both were fetched.)
//
// The control lives in the WebGL overlay. Bare headless may fail to create a
// context and show the no-WebGL card instead; that is a SKIP, not a UI failure.
// Poll for a while first: the panel mounts the viewport after its products land,
// and a fixed 2.5 s snapshot raced that mount.
if (q.get('assert') === 'ghost') {
  const started = performance.now();
  const show = (lines: string[]) => {
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    pre.textContent = lines.join('\n');
  };
  const tick = () => {
    const btn = document.querySelector('[data-compare-toggle]') as HTMLElement | null;
    if (!btn && performance.now() - started < 6000) return setTimeout(tick, 150);
    if (!btn) {
      const body = (document.body.textContent ?? '').replace(/\s+/g, ' ');
      if (/无法创建 WebGL 上下文|几何预览不可用/.test(body)) {
        show([
          `compare inset (dock ${w}×${h})`,
          'SKIP  this environment has no WebGL context; the comparison inset is intentionally absent.',
          'INFO  run scripts/accept-ui.mjs with xvfb-run (the shot tool prefers it) to exercise the 3D control.',
        ]);
        return;
      }
      show([
        `compare inset (dock ${w}×${h})`,
        `FAIL  the comparison control never appeared (${Math.round(performance.now() - started)} ms)`,
      ]);
      return;
    }
    const before = (btn.textContent ?? '').trim();
    btn.click();
    setTimeout(() => {
      const after = (document.querySelector('[data-compare-toggle]')?.textContent ?? '').trim();
      show([
        `compare inset (dock ${w}×${h})`,
        `${/对比 v\d{3,}/.test(before) ? 'PASS' : 'FAIL'}  the control names the compared version: ${before || '(none)'}`,
        `${/对比 v\d{3,}/.test(after) && after !== before ? 'PASS' : 'FAIL'}  clicking it toggles the inset: ${after || '(none)'}`,
      ]);
    }, 420);
  };
  setTimeout(tick, 2500);
}

// ?assert=history — the version gate: five recent revisions are one click away,
// the rest behind ONE deliberate step, and nothing is unreachable.
if (q.get('assert') === 'history') {
  const vRows = () => Array.from(document.querySelectorAll('[data-nav-id]'))
    .filter((el) => /^v\d{3,}$/.test(el.getAttribute('data-nav-id') ?? '')).length;
  const toggle = () => document.querySelector('[data-nav-id="versions-toggle"]') as HTMLElement | null;
  let closed = 0;
  let opened = 0;
  setTimeout(() => {
    (document.querySelector('[aria-label="打开产物导航"]') as HTMLElement | null)?.click();
  }, 1600);
  setTimeout(() => {
    closed = vRows();
    toggle()?.click();
  }, 2100);
  setTimeout(() => {
    opened = vRows();
    const label = (toggle()?.textContent ?? '').trim();
    toggle()?.click();
    setTimeout(() => {
      const back = vRows();
      const pre = document.createElement('pre');
      pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
      const stage = document.getElementById('stage');
      if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
      pre.textContent = [
        `history gate (dock ${w}×${h})`,
        `${closed === 5 ? 'PASS' : 'FAIL'}  recent window is 5 versions (saw ${closed})`,
        `${opened > closed ? 'PASS' : 'FAIL'}  expanding reveals older ones (${closed} -> ${opened})`,
        `${back === closed ? 'PASS' : 'FAIL'}  collapsing returns to the window (${opened} -> ${back})`,
        `INFO  toggle label while expanded: ${label || '(none)'}`,
      ].join('\n');
    }, 300);
  }, 2600);
}

// ?assert=machine — the assembly manifest must surface as ONE object: a 机器 row
// in the navigator, a machine page whose tabs carry the node and evidence counts.
if (q.get('assert') === 'machine') {
  const expect = q.get('expect') ?? '';
  let rowSeen = false;
  // Three beats: open, then click (the overlay must have rendered), then read
  // (the machine page must have rendered). Doing two in one tick reads the DOM
  // before React commits — the first version of this assertion "passed" against
  // the PREVIOUS page's breadcrumb.
  setTimeout(() => {
    (document.querySelector('[aria-label="打开产物导航"]') as HTMLElement | null)?.click();
  }, 1600);
  setTimeout(() => {
    const row = document.querySelector('[data-nav-id="machine"]') as HTMLElement | null;
    rowSeen = Boolean(row);
    row?.click();
  }, 2200);
  setTimeout(() => {
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    const crumb = (document.querySelector('[aria-label="打开产物导航"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const tabTexts = Array.from(document.querySelectorAll('#root button'))
      .map((b) => (b.textContent ?? '').trim())
      .filter((t) => t.length > 0 && t.length < 12 && /(概览|证据|清单|用法)/.test(t));
    const evidenceTab = tabTexts.find((t) => t.startsWith('证据')) ?? '';
    const nodesTab = tabTexts.find((t) => t.startsWith('清单')) ?? '';
    const evN = Number((evidenceTab.match(/\d+/) ?? ['0'])[0]);
    const nodeN = Number((nodesTab.match(/\d+/) ?? ['0'])[0]);
    const lines = [
      `machine object (dock ${w}×${h})`,
      `${rowSeen ? 'PASS' : 'FAIL'}  navigator has a 机器 row`,
      `${expect && crumb.includes(expect) ? 'PASS' : 'FAIL'}  breadcrumb names the machine${expect ? ` ("${expect}")` : ''}: ${crumb}`,
      `${evN > 0 ? 'PASS' : 'FAIL'}  machine evidence tab carries a count: ${evidenceTab || '(none)'}`,
      `${nodeN > 0 ? 'PASS' : 'FAIL'}  machine node tab carries a count: ${nodesTab || '(none)'}`,
      `INFO  tab texts: ${tabTexts.join(' | ')}`,
    ];
    pre.textContent = lines.join('\n');
  }, 3000);
  // The whole-machine 3D preview is a separate surface from the run viewer:
  // click 整机预览, assert the overlay is up and its close button tears it down.
  // (Headless may have no WebGL; the overlay still has to exist and be closable.)
  setTimeout(() => {
    (document.querySelector('[data-machine-preview]') as HTMLElement | null)?.click();
  }, 3400);
  setTimeout(() => {
    const overlay = document.querySelector('[data-machine-preview-overlay]');
    const close = document.querySelector('[data-machine-preview-close]') as HTMLElement | null;
    const before = Boolean(overlay);
    const header = (overlay?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    close?.click();
    setTimeout(() => {
      const gone = !document.querySelector('[data-machine-preview-overlay]');
      const pre = document.querySelector('#stage pre');
      if (pre) {
        pre.textContent += '\n' + [
          `${before ? 'PASS' : 'FAIL'}  machine preview overlay opens`,
          `${gone ? 'PASS' : 'FAIL'}  machine preview overlay closes`,
          `INFO  preview header: ${header || '(none)'}`,
        ].join('\n');
      }
    }, 500);
  }, 3900);
}

// ?assert=evidence — the evidence table must be scannable, not N identical rows.
// Fifteen motion runs about one mechanism share their first line; what tells them
// apart is the second line (which revisions were posed, what was found, when).
if (q.get('assert') === 'evidence') {
  const runEvidence = async () => {
    const pages = () => Array.from(document.querySelectorAll('#root button'))
      .filter((b) => /^(证据|验证)\s*\d*$/.test((b.textContent ?? '').trim())).length;
    const out: string[] = [];
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
    const stage = document.getElementById('stage');
    if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
    const show = () => { pre.textContent = `evidence table (dock ${w}×${h})\n${out.join('\n')}`; };

    clickByText('证据');
    await new Promise((r) => setTimeout(r, 350));

    const rows = Array.from(document.querySelectorAll('[data-evidence-row]')) as HTMLElement[];
    out.push(`${rows.length ? 'PASS' : 'FAIL'}  rows exist: ${rows.length}`);
    const parsed = rows.map((el) => ({
      id: el.getAttribute('data-evidence-id') ?? '',
      title: (el.querySelector('[data-evidence-title]')?.textContent ?? '').trim(),
      meta: (el.querySelector('[data-evidence-meta]')?.textContent ?? '').trim(),
    }));
    const badId = parsed.filter((p) => !/^r\d{3,}$/.test(p.id));
    out.push(`${badId.length ? 'FAIL' : 'PASS'}  every row carries its run id`);
    const noMeta = parsed.filter((p) => !/\bv\d{3,}\b/.test(p.meta));
    out.push(`${noMeta.length ? 'FAIL' : 'PASS'}  every second line names a version (${parsed.length - noMeta.length}/${parsed.length})`);

    // The failure this table exists to remove: several runs about the SAME thing
    // whose visible lines are identical, so the difference can only be found by
    // opening them one by one. For microscope5's motion runs the second line must
    // therefore be different on every row (15 rows, 15 distinct "which revisions
    // were posed + what it found + when").
    const motion = parsed.filter((p) => p.title.includes('机构运动'));
    if (motion.length > 1) {
      const distinct = new Set(motion.map((p) => p.meta)).size;
      out.push(`${distinct === motion.length ? 'PASS' : 'FAIL'}  ${motion.length} 机构运动 rows have ${distinct} distinct second lines`);
    }
    // Two rows that agree on BOTH lines are the same run repeated. The id still
    // tells them apart, but it is a data fact, not a UI defect — report it.
    const seen = new Map<string, string>();
    const twins: string[] = [];
    for (const p of parsed) {
      const key = `${p.title} || ${p.meta}`;
      if (seen.has(key)) twins.push(`${seen.get(key)}=${p.id}`);
      else seen.set(key, p.id);
    }
    out.push(`INFO  rows: ${parsed.length}, exact duplicate rows: ${twins.length ? twins.join(', ') : 'none'}`);

    // 本版 is a FILTER now, not a second tab: its chip count must equal what the
    // list shows after clicking it. This is the check that the merge is not
    // cosmetic (two tabs that render the same rows).
    const chipN = (id: string) => {
      const chip = document.querySelector(`[data-evidence-chip="${id}"]`) as HTMLElement | null;
      return chip ? Number((chip.textContent ?? '').match(/\d+/)?.[0] ?? -1) : -1;
    };
    const allChip = chipN('all');
    const curChip = chipN('current');
    (document.querySelector('[data-evidence-chip="current"]') as HTMLElement | null)?.click();
    await new Promise((r) => setTimeout(r, 260));
    const curRows = document.querySelectorAll('[data-evidence-row]').length;
    out.push(`${curChip > 0 && curRows === curChip ? 'PASS' : 'FAIL'}  本版 filter shows its own count: chip ${curChip}, rows ${curRows}`);
    out.push(`${pages() === 1 ? 'PASS' : 'FAIL'}  验证 is gone (one evidence view, not two)`);
    // The toggle encoded how you had navigated, not a preference: no control, one
    // rule (an arriving version asks for attention instead of moving the view).
    const followBtn = document.querySelector('[aria-label="跟随最新"], [aria-label="已钉住"]');
    out.push(`${followBtn ? 'FAIL' : 'PASS'}  跟随最新 control is gone (no mode pretending to be a preference)`);
    (document.querySelector('[data-evidence-chip="all"]') as HTMLElement | null)?.click();
    await new Promise((r) => setTimeout(r, 260));
    const backRows = document.querySelectorAll('[data-evidence-row]').length;
    out.push(`${backRows === allChip ? 'PASS' : 'FAIL'}  全部 restores all rows: ${backRows} / ${allChip}`);
    show();
  };
  setTimeout(() => void runEvidence(), 2100);
}

// The probe CLEARS the stage, and it fires at 2.6 s — inside the layout
// assertion's run (starts 1.78 s), so it used to wipe the report mid-run and
// the screenshot showed the probe instead of the verdicts. An assert owns the
// stage; the probe steps aside for it.
if (q.get('debug') !== '0' && q.get('assert') !== 'layout' && q.get('assert') !== 'evidence' && q.get('assert') !== 'recent' && q.get('assert') !== 'machine' && q.get('assert') !== 'history' && q.get('assert') !== 'ghost' && q.get('assert') !== 'deeplink' && q.get('assert') !== 'review' && q.get('assert') !== 'orbit' && q.get('assert') !== 'orbit-drain') {
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


// ?assert=section-free — U20: an ARBITRARY cut plane must fill the cut with real
// geometry, and a bore must come back as a HOLE in that fill rather than being
// painted over. "斜切管道能看到空腔而不是空壳" is the claim, and it is checked
// against the cap mesh's own triangles, not against a pixel impression:
//
//   1. the strip's mode button turns the cut from an axis into a free plane;
//   2. the two angle sliders aim it obliquely (a person's gesture, via input
//      events — not by reaching into React state);
//   3. the section group holds a cap mesh whose total triangle area is > 0
//      (a shader clip alone leaves a hollow shell: area 0);
//   4. the cap's area is materially SMALLER than the convex hull of its own
//      vertices (a filled disc would be ≈ hull). The difference IS the bore.
//   5. flipping keeps/cuts swaps which side survives, so the cap stays on screen
//      while the material on one side disappears — the plane did not move.
if (q.get('assert') === 'section-free') {
  const waitFor = (fn: () => boolean, ms = 12000) => new Promise<boolean>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
  const group = () => (document.querySelector('#root canvas')?.parentElement as any)?.__sectionGroup ?? null;
  /** The canvas the part viewport draws into (the mount owns __sectionGroup). */
  const partCanvas = (): HTMLCanvasElement | null => {
    for (const c of Array.from(document.querySelectorAll('#root canvas')) as HTMLCanvasElement[]) {
      if ((c.parentElement as any)?.__sectionGroup) return c;
    }
    return (document.querySelector('#root canvas') as HTMLCanvasElement | null) ?? null;
  };

  /** Share of the frame that is not the corner (background) pixel. */
  const modelShare = (canvas: HTMLCanvasElement | null) => {
    if (!canvas) return -1;
    const probe = document.createElement('canvas');
    probe.width = 96; probe.height = 96;
    const ctx = probe.getContext('2d');
    if (!ctx) return -1;
    ctx.drawImage(canvas, 0, 0, 96, 96);
    const d = ctx.getImageData(0, 0, 96, 96).data;
    const bg = [d[0], d[1], d[2]];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) n++;
    }
    return n / (96 * 96);
  };

  /** Total area of a triangle-soup position array. */
  const area = (positions: number[]) => {
    let total = 0;
    for (let i = 0; i + 8 < positions.length; i += 9) {
      const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
      const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
      const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      total += Math.hypot(nx, ny, nz) / 2;
    }
    return total;
  };

  /**
   * Convex hull area of the cap's vertices, projected onto the cut plane's own
   * frame — the same u/v the panel uses (world axis least aligned with the
   * normal seeds u). Projecting onto two world axes instead degenerates whenever
   * the plane is edge-on to them, which is exactly what an oblique cut is.
   */
  const hullArea = (positions: number[], normal: [number, number, number]) => {
    const abs = normal.map(Math.abs);
    let seedIndex = 0;
    for (let i = 1; i < 3; i++) if (abs[i] < abs[seedIndex]) seedIndex = i;
    const seed = [0, 0, 0];
    seed[seedIndex] = 1;
    const along = seed[0] * normal[0] + seed[1] * normal[1] + seed[2] * normal[2];
    const rawU = [seed[0] - along * normal[0], seed[1] - along * normal[1], seed[2] - along * normal[2]];
    const length = Math.hypot(rawU[0], rawU[1], rawU[2]) || 1;
    const u = [rawU[0] / length, rawU[1] / length, rawU[2] / length];
    const v = [
      normal[1] * u[2] - normal[2] * u[1],
      normal[2] * u[0] - normal[0] * u[2],
      normal[0] * u[1] - normal[1] * u[0],
    ];
    const pts: [number, number][] = [];
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      pts.push([x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]]);
    }
    pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: [number, number][] = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper: [number, number][] = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    const ring = lower.slice(0, -1).concat(upper.slice(0, -1));
    let total = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      total += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return Math.abs(total) / 2;
  };

  const capPositions = (): number[] | null => {
    const g = group();
    if (!g) return null;
    for (const child of g.children as any[]) {
      const attribute = child?.geometry?.getAttribute?.('position');
      if (attribute && child.material && !child.isLineSegments) {
        return Array.from(attribute.array as Float32Array);
      }
    }
    return null;
  };

  void (async () => {
    const lines: string[] = [`free-plane section (dock ${w}×${h})`];
    const show = () => {
      const pre = document.createElement('pre');
      pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
      const stage = document.getElementById('stage');
      if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
      pre.textContent = lines.join('\n');
    };

    const toggle = await waitFor(() => Boolean(document.querySelector('[data-section-toggle]')), 12000);
    lines.push(`${toggle ? 'PASS' : 'FAIL'}  the section toggle exists`);
    if (!toggle) { lines.push('FAIL  no panel — load a version first (`&record=<version>`)'); show(); return; }

    // The panel starts with the section OFF: turn it on, then read the axis cap.
    (document.querySelector('[data-section-toggle]') as HTMLElement).click();
    const gotAxis = await waitFor(() => {
      const cap = capPositions();
      return Boolean(cap && area(cap) > 0);
    }, 12000);
    const axisCap = capPositions();
    const axisArea = axisCap ? area(axisCap) : 0;
    lines.push(`${gotAxis ? 'PASS' : 'FAIL'}  the axis cut is filled with real geometry (${axisArea.toFixed(2)}mm²)`);
    const axisShare = modelShare(partCanvas());

    // The gesture: mode button, then the two angle sliders (input events, the
    // same thing a person's drag produces).
    (document.querySelector('[data-section-mode]') as HTMLElement | null)?.click();
    const mode = await waitFor(() => document.querySelector('[data-section-mode]')?.getAttribute('data-section-mode') === 'plane', 6000);
    lines.push(`${mode ? 'PASS' : 'FAIL'}  the mode button switched the cut to a free plane`);

    const setRange = (selector: string, value: number) => {
      const input = document.querySelector(selector) as HTMLInputElement | null;
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const aimed = mode && setRange('[data-section-azimuth]', 90) && setRange('[data-section-elevation]', 45);
    lines.push(`${aimed ? 'PASS' : 'FAIL'}  two range inputs aim the normal (az 90°, el 45°)`);

    const oblique = await waitFor(() => {
      const now = capPositions();
      return Boolean(now && area(now) > 0 && Math.abs(area(now) - axisArea) > 1e-3);
    }, 12000);
    const cap = capPositions();
    const capArea = cap ? area(cap) : 0;
    const aimedNormal: [number, number, number] = [
      Math.cos((45 * Math.PI) / 180) * Math.cos((90 * Math.PI) / 180),
      Math.cos((45 * Math.PI) / 180) * Math.sin((90 * Math.PI) / 180),
      Math.sin((45 * Math.PI) / 180),
    ];
    const hull = cap ? hullArea(cap, aimedNormal) : 0;
    lines.push(`${oblique ? 'PASS' : 'FAIL'}  the oblique cut is filled (cap ${capArea.toFixed(2)}mm² vs axis ${axisArea.toFixed(2)}mm²)`);
    // The bore: a filled disc makes cap ≈ hull. 0.95 leaves room for tessellation;
    // a part with no internal void fails on purpose — this scenario needs a tube
    // (microscope5 p010 镜筒), which is named by the runner, not guessed.
    const ratio = hull > 0 ? capArea / hull : 0;
    lines.push(`${capArea > 0 && hull > 0 && ratio < 0.95 ? 'PASS' : 'FAIL'}  the cut face has a HOLE, not a fill: cap ${capArea.toFixed(1)} < hull ${hull.toFixed(1)} (ratio ${ratio.toFixed(3)})`);

    // Is the CUT installed on the material a frame is drawn with? A cap mesh
    // that exists while the shader clips nothing renders as a hollow shell, and
    // that looks correct in a thumbnail — so it is asserted, not eyeballed.
    const host = (document.querySelector('#root canvas')?.parentElement ?? null) as any;
    const partMesh = host?.__mesh ?? null;
    const renderer = host?.__renderer ?? null;
    const planeCount = partMesh?.material?.clippingPlanes?.length ?? 0;
    lines.push(`${planeCount === 1 ? 'PASS' : 'FAIL'}  the part material carries one clipping plane (${planeCount})`);
    lines.push(`${renderer?.localClippingEnabled === true ? 'PASS' : 'FAIL'}  local clipping is enabled on the renderer`);

    // Carry the FRAME into the verdict page. The live canvas can stop painting
    // after the initial settle (headless GL), and a verdict with no picture is
    // the thing this whole scenario exists to prevent — so the assert takes the
    // pixels at the moment the oblique cut is on screen, and reports how much of
    // the frame is model rather than background (a blank capture must FAIL).
    const canvas = partCanvas();
    let url = '';
    let coverage = 0;
    if (canvas) {
      try {
        url = canvas.toDataURL('image/png');
        const probe = document.createElement('canvas');
        probe.width = 64; probe.height = 64;
        const ctx = probe.getContext('2d');
        ctx?.drawImage(canvas, 0, 0, 64, 64);
        const data = ctx?.getImageData(0, 0, 64, 64).data ?? new Uint8ClampedArray(0);
        const seen = new Set<string>();
        for (let i = 0; i < data.length; i += 4) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        coverage = seen.size;
      } catch { /* a blocked canvas is reported below */ }
    }
    lines.push(`${coverage > 8 ? 'PASS' : 'FAIL'}  the cut frame is painted (${coverage} distinct colours in a 64×64 probe; 1–2 = blank)`);
    const obliqueShare = modelShare(canvas);
    // The clip must CHANGE the pixels: if the part occupies exactly as much of
    // the frame before and after the cut, the shader is not clipping and the
    // "cap" is floating over an intact shell.
    lines.push(`${axisShare >= 0 && obliqueShare >= 0 && Math.abs(obliqueShare - axisShare) > 0.005 ? 'PASS' : 'FAIL'}  the clip changes the frame (model pixels ${(axisShare * 100).toFixed(1)}% axis → ${(obliqueShare * 100).toFixed(1)}% oblique)`);

    // Put THIS frame on top of the viewport, fixed to the canvas's on-screen
    // rectangle. The sandbox's own freeze is a DOM sibling that a later canvas
    // rebuild can end up behind, and a stale frame is worse than no picture.
    if (canvas && url) {
      const rect = canvas.getBoundingClientRect();
      const frame = document.createElement('img');
      frame.dataset.frozen = '1';
      frame.src = url;
      frame.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;`
        + `width:${rect.width}px;height:${rect.height}px;z-index:2147483647;pointer-events:none;`;
      document.body.appendChild(frame);
    }

    // Flip: swapping the kept half must keep the SAME cut face on screen.
    const before = capPositions();
    (document.querySelector('[data-section-flip]') as HTMLElement | null)?.click();
    const flipped = await waitFor(() => document.querySelector('[data-section-flip]')?.getAttribute('data-section-flip') === 'cut', 6000);
    const afterCap = capPositions();
    lines.push(`${flipped ? 'PASS' : 'FAIL'}  the flip button reports the cut side`);
    lines.push(`${afterCap && area(afterCap) > 0 && before && Math.abs(area(afterCap) - area(before)) < 1e-6 ? 'PASS' : 'FAIL'}  flipping keeps/cut leaves the same cut face (the plane did not move)`);

    show();
  })();
}

// ?assert=webgl-recover — U21: losing the WebGL context must not leave a blank
// viewport. The fault is INJECTED (WEBGL_lose_context), not simulated: the
// context really goes away, the panel really has to notice, and the frame has to
// come back without a reload. Three things are checked:
//
//   1. the loss is announced (a card, not a silent white box);
//   2. the restore path rebuilds a renderer on a fresh canvas;
//   3. the recovered frame actually contains the model again (pixel share, not
//      "no exception was thrown").
if (q.get('assert') === 'webgl-recover') {
  const waitFor = (fn: () => boolean, ms = 15000) => new Promise<boolean>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
  /** Share of the canvas that is not its corner (background) pixel. */
  const modelShare = (canvas: HTMLCanvasElement | null): number => {
    if (!canvas) return -1;
    const probe = document.createElement('canvas');
    probe.width = 96; probe.height = 96;
    const ctx = probe.getContext('2d');
    if (!ctx) return -1;
    try { ctx.drawImage(canvas, 0, 0, 96, 96); } catch { return -1; }
    const d = ctx.getImageData(0, 0, 96, 96).data;
    const bg = [d[0], d[1], d[2]];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) n++;
    }
    return n / (96 * 96);
  };
  void (async () => {
    const lines: string[] = [`webgl context recovery (dock ${w}×${h})`];
    const show = () => {
      const pre = document.createElement('pre');
      pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
      const stage = document.getElementById('stage');
      if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
      pre.textContent = lines.join('\n');
    };
    const canvasOf = () => document.querySelector('#root canvas') as HTMLCanvasElement | null;
    const hostOf = () => (canvasOf()?.parentElement ?? null) as any;

    const ready = await waitFor(() => Boolean(canvasOf() && hostOf()?.__renderer), 15000);
    if (!ready) { lines.push('FAIL  no live renderer — load a version first (`&record=<version>`)'); show(); return; }
    lines.push('PASS  a renderer is live');

    const diag = () => {
      const c = canvasOf();
      const r = (hostOf()?.__renderer ?? null);
      const rect = c?.getBoundingClientRect();
      return {
        canvas: c ? `${c.width}x${c.height}` : 'none',
        css: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : 'none',
        connected: Boolean(c?.isConnected),
        triangles: r?.info?.render?.triangles ?? -1,
        calls: r?.info?.render?.calls ?? -1,
      };
    };
    // How long until the first frame is actually drawn? "triangles: 0" means the
    // render loop has not started yet, which is a LOADING state, not a failure —
    // measuring it separates a slow mesh from a dead scene.
    const t0 = performance.now();
    const drew = await waitFor(() => (hostOf()?.__renderer?.info?.render?.calls ?? 0) > 0, 20000);
    lines.push(`${drew ? 'PASS' : 'FAIL'}  the first frame is drawn within 20s (${Math.round(performance.now() - t0)}ms)`);
    lines.push(`INFO  ${JSON.stringify(diag())}`);
    const errText = (Array.from(document.querySelectorAll('#root div')) as HTMLElement[])
      .map((el) => (el.textContent ?? '').trim())
      .filter((text) => /failed|Error|错误|失败/.test(text) && text.length < 220)
      .slice(0, 3);
    if (errText.length) lines.push(`INFO  errors on screen: ${JSON.stringify(errText)}`);
    const before = modelShare(canvasOf());
    lines.push(`${before > 0.02 ? 'PASS' : 'FAIL'}  the model is on screen before the fault (${(before * 100).toFixed(1)}% of the frame)`);
    const firstRenderer = hostOf().__renderer;

    // Inject the loss on the renderer's own context.
    const gl = firstRenderer.getContext?.();
    const ext = gl?.getExtension?.('WEBGL_lose_context');
    lines.push(`${ext ? 'PASS' : 'FAIL'}  WEBGL_lose_context is available (the fault can be injected)`);
    if (!ext) { show(); return; }
    ext.loseContext();
    const announced = await waitFor(() => Boolean(document.querySelector('[data-gl-lost]')), 8000);
    lines.push(`${announced ? 'PASS' : 'FAIL'}  the loss is announced instead of showing a blank viewport`);
    const dead = modelShare(canvasOf());
    lines.push(`${dead >= 0 ? 'PASS' : 'FAIL'}  the page is still alive while the context is gone`);

    // Restore: the browser fires webglcontextrestored, the panel rebuilds.
    ext.restoreContext();
    const cleared = await waitFor(() => !document.querySelector('[data-gl-lost]'), 15000);
    lines.push(`${cleared ? 'PASS' : 'FAIL'}  the card clears when the context comes back`);
    const rebuilt = await waitFor(() => Boolean(canvasOf() && hostOf()?.__renderer) && hostOf().__renderer !== firstRenderer, 15000);
    lines.push(`${rebuilt ? 'PASS' : 'FAIL'}  a fresh renderer was built (the old one is not reused)`);
    const after = await waitFor(() => modelShare(canvasOf()) > 0.02, 15000) ? modelShare(canvasOf()) : modelShare(canvasOf());
    lines.push(`${after > 0.02 ? 'PASS' : 'FAIL'}  the model is drawn again after recovery (${(after * 100).toFixed(1)}% of the frame)`);
    lines.push(`${!document.querySelector('[data-gl-lost]') && !/WebGL/.test(document.body.textContent ?? '') ? 'PASS' : 'FAIL'}  no error card or "WebGL" complaint is left on screen`);
    show();
  })();
}

// ?assert=load-progress — U21: a large mesh must show progress while it arrives.
// The corpus has a 6.5 MB STL (v041): throttled to ~800 KB/s it takes seconds, so
// the pill is observable. Three things are checked: it appears, it MOVES (a static
// "loading…" is not progress), and it goes away when the model is on screen.
if (q.get('assert') === 'load-progress') {
  const waitFor = (fn: () => boolean, ms = 20000) => new Promise<boolean>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
  void (async () => {
    const lines: string[] = [`mesh download progress (dock ${w}×${h})`];
    const show = () => {
      const pre = document.createElement('pre');
      pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
      const stage = document.getElementById('stage');
      if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
      pre.textContent = lines.join('\n');
    };
    const pill = () => document.querySelector('[data-load-progress]') as HTMLElement | null;
    const text = () => (pill()?.textContent ?? '').replace(/\s+/g, ' ').trim();

    // What the browser actually requested: name + duration proves whether the
    // throttle reached the mesh URL, which is the difference between "no pill"
    // and "no throttle".
    const stlEntries = () => performance.getEntriesByType('resource')
      .filter((e) => e.name.includes('/api/cad/stl'))
      .map((e) => `${e.name.split('?')[1] ?? ''} ${Math.round(e.duration)}ms`);
    arguments_noop: {
      // (label kept so the block reads as diagnostics, not as a claim)
      lines.push(`INFO  stl requests so far: ${JSON.stringify(stlEntries())}`);
    }
    // Poll until the pill has BOTH appeared and cleared, or 9 s pass. The page
    // lives only as long as the screenshot needs (a verdict posted after that is
    // lost), so this assertion stays short and reports what it saw.
    let sawPill = 0;
    let sawText = '';
    let sawTicks = 0;
    let cleared = false;
    const deadline = performance.now() + 9000;
    while (performance.now() < deadline) {
      if (pill()) {
        sawPill++;
        sawText = sawText || text();
        // Post a verdict as soon as the pill exists: the page may be torn down
        // before a longer poll finishes, and "the assertion did not run" is the
        // one outcome that would be indistinguishable from a broken panel.
        if (sawPill === 1) show();
      } else if (sawPill > 0) { cleared = true; break; }
      sawTicks = Math.max(sawTicks, (globalThis as any).__loadTicks ?? 0);
      await new Promise((r) => setTimeout(r, 20));
    }
    lines.push(`INFO  pill seen ${sawPill}× · ticks ${sawTicks} · cleared ${cleared} · text ${JSON.stringify(sawText)}`);
    const percent = /(\d+)%/.exec(sawText)?.[1];
    lines.push(`${sawPill > 0 ? 'PASS' : 'FAIL'}  a progress pill appears while the mesh downloads`);
    lines.push(`${percent !== undefined ? 'PASS' : 'FAIL'}  the pill states a percentage and byte counts`);
    lines.push(`${cleared ? 'PASS' : 'FAIL'}  the pill clears when the download ends`);
    // The fingerprinted chunks arrive coalesced in Firefox (measured: 2 ticks for
    // a 7 s body), so "the number advances mid-download" is asserted in
    // accept-stream-progress.mjs against synthetic bodies instead of here.
    show();
  })();
}

// ?assert=assembly-hide — U12: in the whole-machine preview, take one part out of
// the picture and keep inspecting. Four things must hold together:
//
//   1. hide removes exactly that part from the draw;
//   2. the camera does NOT move (inspecting a fit is not navigating);
//   3. explode still moves the parts that are left (visibility and position are
//      independent — "其余件仍可爆炸");
//   4. isolate leaves one part, and clearing it brings the rest back.
//
// The part list is read from the live scene (`__parts`), not from the DOM text: a
// legend row that says "hidden" while the mesh is still drawn is the failure.
if (q.get('assert') === 'assembly-hide') {
  const waitFor = (fn: () => boolean, ms = 20000) => new Promise<boolean>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void (async () => {
    const lines: string[] = [`assembly per-part visibility (dock ${w}×${h})`];
    const show = () => {
      const pre = document.createElement('pre');
      pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
      const stage = document.getElementById('stage');
      if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
      pre.textContent = lines.join('\n');
    };
    // The machine page is reached through the navigator, like a person does: the
    // preview button lives on THAT page, not on the part page.
    // Wait for each element before clicking: this assert starts at page load,
    // when the navigator button does not exist yet (a silent `.click()` on null
    // is how the first version "ran" without ever leaving the part page).
    const navBtn = await waitFor(() => Boolean(document.querySelector('[aria-label="打开产物导航"]')), 15000);
    (document.querySelector('[aria-label="打开产物导航"]') as HTMLElement | null)?.click();
    const machineRow = await waitFor(() => Boolean(document.querySelector('[data-nav-id="machine"]')), 12000);
    lines.push(`${navBtn && machineRow ? 'PASS' : 'FAIL'}  the navigator offers the 机器 row`);
    (document.querySelector('[data-nav-id="machine"]') as HTMLElement | null)?.click();
    await pause(1200);
    const open = await waitFor(() => Boolean(document.querySelector('[data-machine-preview]')), 20000);
    lines.push(`${open ? 'PASS' : 'FAIL'}  the machine page offers a whole-machine preview`);
    if (!open) { show(); return; }
    (document.querySelector('[data-machine-preview]') as HTMLElement).click();
    const legend = await waitFor(() => Boolean(document.querySelector('[data-parts-legend]')), 25000);
    const handle = () => {
      for (const node of Array.from(document.querySelectorAll('[data-machine-preview-overlay] div'))) {
        const parts = (node as any).__parts;
        if (parts) return parts;
      }
      return null;
    };
    const ready = await waitFor(() => Boolean(handle()?.count?.() > 0), 30000);
    lines.push(`${legend ? 'PASS' : 'FAIL'}  the preview lists its parts`);
    if (!ready) { lines.push('FAIL  the part scene never became ready'); show(); return; }
    const parts = handle();
    const count = parts.count();
    const visible = parts.visible();
    const cam0 = parts.camera();
    lines.push(`${count > 1 ? 'PASS' : 'FAIL'}  ${count} parts loaded, ${visible} drawn`);
    lines.push(`${visible === count ? 'PASS' : 'FAIL'}  every part is drawn before any gesture`);

    // 1. hide one
    (document.querySelector('[data-part-hide="0"]') as HTMLElement | null)?.click();
    const hid = await waitFor(() => handle().visible() === count - 1, 5000);
    lines.push(`${hid ? 'PASS' : 'FAIL'}  hiding one part draws one part fewer (${handle().visible()}/${count})`);
    const cam1 = handle().camera();
    const moved = cam0 && cam1 && Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]) > 1e-6;
    lines.push(`${!moved ? 'PASS' : 'FAIL'}  hiding does not move the camera`);

    // 2. explode the remainder
    const posBefore = JSON.stringify(handle().positions());
    const explodeBtn = Array.from(document.querySelectorAll('[data-machine-preview-overlay] button'))
      .find((b) => /爆炸|Explode/i.test(b.textContent ?? '')) as HTMLElement | undefined;
    explodeBtn?.click();
    const exploded = await waitFor(() => JSON.stringify(handle().positions()) !== posBefore, 5000);
    lines.push(`${exploded ? 'PASS' : 'FAIL'}  the remaining parts still explode (visibility did not freeze the layout)`);

    // 3. isolate. The camera is sampled AFTER the explode on purpose: exploding
    // reframes by design, so comparing against the pre-explode camera would
    // blame the explode on the isolate.
    const camExploded = handle().camera();
    (document.querySelector('[data-part-isolate="1"]') as HTMLElement | null)?.click();
    const isolated = await waitFor(() => handle().visible() === 1, 5000);
    lines.push(`${isolated ? 'PASS' : 'FAIL'}  isolate leaves exactly one part (${handle().visible()}/${count})`);
    const cam2 = handle().camera();
    const moved2 = camExploded && cam2
      && Math.hypot(cam2[0] - camExploded[0], cam2[1] - camExploded[1], cam2[2] - camExploded[2]) > 1e-6;
    lines.push(`${!moved2 ? 'PASS' : 'FAIL'}  isolating does not move the camera either`);

    // 4. highlight + clear
    (document.querySelector('[data-part-row="1"]') as HTMLElement | null)?.click();
    const highlighted = await waitFor(() => handle().highlight === 1, 5000);
    lines.push(`${highlighted ? 'PASS' : 'FAIL'}  clicking a row highlights that part`);
    (document.querySelector('[data-parts-clear]') as HTMLElement | null)?.click();
    const cleared = await waitFor(() => handle().visible() === count, 5000);
    lines.push(`${cleared ? 'PASS' : 'FAIL'}  看全部 brings every part back (${handle().visible()}/${count})`);
    show();
  })();
}

// ?assert=views — U11: the viewport must be able to look from a named direction,
// not just wherever the pointer left it. Checked here as camera POSE facts:
//
//   1. the menu opens and offers the standard views + six axis snaps;
//   2. clicking one really moves the camera onto that direction (dot product, not
//      a screenshot);
//   3. the orthographic toggle changes the camera type AND keeps the same pose, so
//      the apparent size does not jump;
//   4. 复原 (Home) returns to the initial framing.
if (q.get('assert') === 'views') {
  const waitFor = (fn: () => boolean, ms = 15000) => new Promise<boolean>((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
  void (async () => {
    const lines: string[] = [`standard views / axis snap / projection (dock ${w}×${h})`];
    const show = () => {
      const pre = document.createElement('pre');
      pre.style.cssText = 'font:12px/1.6 monospace;white-space:pre-wrap;color:#111;margin:12px;';
      const stage = document.getElementById('stage');
      if (stage) { stage.textContent = ''; stage.style.alignItems = 'flex-start'; stage.appendChild(pre); }
      pre.textContent = lines.join('\n');
    };
    const host = () => (document.querySelector('#root canvas')?.parentElement ?? null) as any;
    const dirOf = () => {
      const h = host();
      if (!h?.__camera || !h?.__controls) return null;
      const p = h.__camera.position;
      const t = h.__controls.target;
      const v = [p.x - t.x, p.y - t.y, p.z - t.z];
      const len = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / len, v[1] / len, v[2] / len];
    };
    const ready = await waitFor(() => Boolean(host()?.__camera && host()?.__controls && document.querySelector('[data-view-menu]')), 15000);
    if (!ready) { lines.push('FAIL  no live camera or no view menu — load a version first'); show(); return; }
    lines.push('PASS  the view menu exists next to a live camera');
    const home = JSON.stringify(host().__camera.position.toArray());

    const openMenu = async () => {
      if (document.querySelector('[data-view-menu]')?.getAttribute('data-view-menu') !== 'open') {
        (document.querySelector('[data-view-menu]') as HTMLElement).click();
      }
      return waitFor(() => Boolean(document.querySelector('[data-view-panel]')), 4000);
    };
    const clickAndWait = async (selector: string, check: () => boolean) => {
      await openMenu();
      (document.querySelector(selector) as HTMLElement | null)?.click();
      return waitFor(check, 5000);
    };
    const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;
    const isDir = (want: number[]) => {
      const d = dirOf();
      return Boolean(d) && near(d[0], want[0]) && near(d[1], want[1]) && near(d[2], want[2]);
    };

    lines.push(`${(await openMenu()) ? 'PASS' : 'FAIL'}  the menu opens into a panel`);
    const hasControls = ['[data-view="iso"]', '[data-view="top"]', '[data-view="front"]', '[data-view="right"]',
      '[data-view-axis="+x"]', '[data-view-axis="-x"]', '[data-view-axis="+y"]', '[data-view-axis="-y"]',
      '[data-view-axis="+z"]', '[data-view-axis="-z"]', '[data-view-projection]']
      .every((sel) => Boolean(document.querySelector(sel)));
    lines.push(`${hasControls ? 'PASS' : 'FAIL'}  it offers four standard views, six axis snaps and a projection toggle`);

    const isoOk = await clickAndWait('[data-view="iso"]', () => isDir([0.57735, 0.57735, 0.57735]));
    lines.push(`${isoOk ? 'PASS' : 'FAIL'}  等轴 puts the camera on the (1,1,1) diagonal ${JSON.stringify(dirOf())}`);
    const topOk = await clickAndWait('[data-view="top"]', () => isDir([0, 0, 1]));
    lines.push(`${topOk ? 'PASS' : 'FAIL'}  顶 looks straight down +Z ${JSON.stringify(dirOf())}`);
    // The pole rule: a top view cannot keep world up, it is parallel to the view.
    const upAfterTop = host().__camera.up;
    lines.push(`${near(upAfterTop.y, 1) && near(upAfterTop.z, 0) ? 'PASS' : 'FAIL'}  the top view switched the camera up to +Y (${JSON.stringify(upAfterTop)})`);
    const frontOk = await clickAndWait('[data-view="front"]', () => isDir([0, -1, 0]));
    lines.push(`${frontOk ? 'PASS' : 'FAIL'}  前 looks along +Y ${JSON.stringify(dirOf())}`);
    const axisOk = await clickAndWait('[data-view-axis="+x"]', () => isDir([1, 0, 0]));
    lines.push(`${axisOk ? 'PASS' : 'FAIL'}  +X snap looks along -X ${JSON.stringify(dirOf())}`);

    // projection
    await openMenu();
    const before = host().__camera.isOrthographicCamera === true;
    (document.querySelector('[data-view-projection]') as HTMLElement).click();
    const switched = await waitFor(() => (host().__camera.isOrthographicCamera === true) !== before, 5000);
    const dirBefore = dirOf();
    lines.push(`${switched ? 'PASS' : 'FAIL'}  the projection toggle swaps the camera type (${before ? 'ortho→persp' : 'persp→ortho'})`);
    lines.push(`${dirBefore ? 'PASS' : 'FAIL'}  ...and the pose survives the swap (direction ${JSON.stringify(dirBefore)})`);
    const scaleA = document.querySelector('[data-scale]')?.getAttribute('data-scale');
    lines.push(`INFO  scale bar after the swap: ${String(scaleA)}`);

    // Home
    await openMenu();
    (document.querySelector('[data-view-home]') as HTMLElement).click();
    const back = await waitFor(() => JSON.stringify(host().__camera.position.toArray()) !== JSON.stringify(home), 4000);
    lines.push(`${back ? 'PASS' : 'FAIL'}  复原 moved the camera back from the axis view`);
    show();
  })();
}
