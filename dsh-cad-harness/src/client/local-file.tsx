/**
 * Local STL files: LOOK at one (no agent, no version), or LAND one (a version).
 *
 * WHY two actions instead of one. The panel is a read-only view over the corpus
 * (`versions/`), so a file on disk is invisible to it and to every tool — the
 * 2026-10-21 case where two finished disks existed only as STLs. But "let me
 * look at this file" and "make this part part of the project" are different
 * commitments:
 *
 *   - PREVIEW parses the bytes in the browser (three.js) and shows them in a
 *     temporary scene. It costs nothing, registers nothing, and can never be
 *     mistaken for evidence: no version, no measurement, no LLM context.
 *   - IMPORT posts the file's SERVER-SIDE path to the existing `/api/cad/import`
 *     door (the same `importPartJob` the `import_part` tool uses), so the file
 *     becomes a version: measurable, assemblable, visible to the agent.
 *
 * The browser cannot name a local path (`<input type=file>` exposes only the
 * file's bytes and name), so import is deliberately a path form. Drag-and-drop
 * bytes → version would need an upload endpoint; that is a separate decision.
 */
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { createFreeOrbit } from './free-orbit';
import { attachStudioLights, configureStudioRenderer } from './lighting';
import { fitDistance } from './fit';
import {
  buildImportStlRequest, partNameFromPath, IMPORT_UNITS,
  type ImportUnit,
} from './local-file-request';

export interface LocalFileDialogProps {
  open: boolean;
  onClose: () => void;
  /** Session cwd: the corpus an import writes to. Empty = could not resolve. */
  project: string;
  /** Viewport ground colour, so the preview belongs to the same panel. */
  background: string;
  /** Called with the new version id; the panel selects and pins it. */
  onImported: (versionId: string) => void;
}

const S = {
  backdrop: {
    position: 'fixed' as const, inset: 0, zIndex: 70,
    background: 'rgba(20,24,30,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  panel: {
    width: 'min(900px, 94vw)', height: 'min(680px, 90vh)',
    display: 'flex', flexDirection: 'column' as const,
    background: '#fff', borderRadius: 12, boxShadow: '0 18px 60px rgba(0,0,0,0.30)',
    overflow: 'hidden',
  },
  head: {
    display: 'flex', alignItems: 'center', gap: 6, flex: 'none', flexWrap: 'wrap' as const, rowGap: 4,
    padding: '8px 10px', borderBottom: '1px solid #e8ecef',
  },
  title: { fontSize: 13, fontWeight: 600 as const, color: '#26303a' },
  tab: (active: boolean) => ({
    cursor: 'pointer', borderRadius: 6, padding: '3px 9px', fontSize: 12, lineHeight: '18px',
    border: `1px solid ${active ? '#4a7dbd' : '#e3e7ea'}`,
    background: active ? '#eaf2fb' : '#f7f9fb', color: active ? '#1f4e79' : '#5b6673',
  }),
  body: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' as const, padding: 10, gap: 8 },
  canvasHost: {
    position: 'relative' as const, flex: '1 1 auto', minHeight: 220,
    border: '1px solid #e3e7ea', borderRadius: 8, overflow: 'hidden', background: '#f0f0f0',
  },
  hint: { fontSize: 11, color: '#8a94a0', lineHeight: 1.5 },
  smallBtn: {
    cursor: 'pointer', borderRadius: 6, padding: '3px 9px', fontSize: 12, lineHeight: '18px',
    border: '1px solid #d5d9dd', background: '#fff', color: '#26303a', whiteSpace: 'nowrap' as const,
  },
  primary: {
    cursor: 'pointer', borderRadius: 6, padding: '4px 12px', fontSize: 12, lineHeight: '18px',
    border: '1px solid #2f6fdb', background: '#2f6fdb', color: '#fff', fontWeight: 600 as const,
  },
  field: {
    display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#3b4450',
  },
  input: {
    flex: '1 1 auto', minWidth: 0, height: 26, fontSize: 12, padding: '0 7px',
    border: '1px solid #d5d9dd', borderRadius: 6, background: '#fff', color: '#26303a',
  },
  error: {
    background: 'rgba(192,57,43,0.08)', border: '1px solid #c0392b', color: '#7b241c',
    borderRadius: 6, padding: '5px 8px', fontSize: 11.5, lineHeight: 1.45,
  },
  ok: {
    background: 'rgba(39,174,96,0.10)', border: '1px solid #27ae60', color: '#1e6f45',
    borderRadius: 6, padding: '5px 8px', fontSize: 11.5, lineHeight: 1.45,
  },
};

interface PreviewStats {
  name: string;
  bytes: number;
  triangles: number;
  /** As read from the file — STL has no unit, so no conversion is implied. */
  size: [number, number, number];
}

export function LocalFileDialog(props: LocalFileDialogProps): React.ReactElement | null {
  const { open, onClose, project, background, onImported } = props;
  // Import is the DEFAULT tab since 2026-10-22: the panel's 未登记 category owns
  // preview (a file in the workspace is previewed there, no modal). This dialog
  // is now the by-path door for files the server cannot address, so it opens on
  // the form; the browser-side preview stays as a fallback for those.
  const [tab, setTab] = useState<'preview' | 'import'>('import');

  // ---- preview state -------------------------------------------------------
  const hostRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const loadRef = useRef<((file: File) => Promise<void>) | null>(null);
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);

  // ---- import state --------------------------------------------------------
  const [path, setPath] = useState('');
  const [unit, setUnit] = useState<ImportUnit>('mm');
  const [partName, setPartName] = useState('');
  const [allowNonSolid, setAllowNonSolid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importInfo, setImportInfo] = useState<string | null>(null);
  /** "You just previewed X, but the browser never sent its path" — carried across tabs. */
  const [importHint, setImportHint] = useState<string | null>(null);

  // Reset when reopened: a stale error/path from the previous file is confusing.
  useEffect(() => {
    if (!open) return;
    setPreviewError(null);
    setPreviewNote(null);
    setImportError(null);
    setImportInfo(null);
    setImportHint(null);
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (!open || tab !== 'preview') return;
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      setPreviewError(`此环境无法创建 WebGL 上下文，预览不可用：${String((e as Error)?.message ?? e)}`);
      return;
    }
    configureStudioRenderer(renderer);
    // A preview is not the product viewport: keep the context cheap but crisp.
    renderer.setSize(host.clientWidth || 480, host.clientHeight || 320);
    // Absolute + z-index 1 so the empty-state / error overlays (z-index 2) stay
    // readable above it — including after the sandbox freezes the canvas into an
    // absolutely-positioned <img>, which would otherwise paint over them.
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.inset = '0';
    renderer.domElement.style.zIndex = '1';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(background);
    const camera = new THREE.PerspectiveCamera(45, (host.clientWidth || 480) / (host.clientHeight || 320), 0.1, 20000);
    attachStudioLights(scene, camera);

    // Free orbit, like the main preview: this dialog inspects a STL before
    // import, so it must not stop at the poles either. min/max are replaced by
    // frame() once the file has parsed.
    const { controls, dispose: disposeControls } = createFreeOrbit(camera, renderer.domElement, {
      target: new THREE.Vector3(),
      minDistance: 0,
      maxDistance: Infinity,
    });

    let mesh: THREE.Mesh | null = null;
    let radius = 50;

    const frame = () => {
      if (!mesh) return;
      const box = mesh.geometry.boundingBox;
      if (!box) return;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      radius = Math.max(size.length() / 2, 0.5);
      controls.target.copy(center);
      camera.up.set(0, 1, 0);
      camera.position.copy(center).addScaledVector(
        new THREE.Vector3(1.6, 1.2, 1.6).normalize(),
        fitDistance(camera, radius),
      );
      controls.minDistance = radius * 0.05;
      controls.maxDistance = radius * 60;
      controls.update();
    };

    loadRef.current = async (file: File) => {
      setPreviewError(null);
      setPreviewNote(null);
      if (!/\.stl$/i.test(file.name)) {
        setPreviewError('浏览器预览只读 STL。STEP/3MF 请切到「导入为版本」（由服务器把几何变成版本）。');
        return;
      }
      if (file.size > 80 * 1024 * 1024) {
        setPreviewError('这个文件超过 80 MB，浏览器解析会卡住。请先简化网格，或直接「导入为版本」。');
        return;
      }
      setLoading(true);
      try {
        const buf = await file.arrayBuffer();
        if (disposed) return;
        const geometry = new STLLoader().parse(buf);
        geometry.computeBoundingBox();
        const box = geometry.boundingBox ?? new THREE.Box3();
        const size = box.getSize(new THREE.Vector3());
        if (mesh) {
          scene.remove(mesh);
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({ color: '#7aa7d9', metalness: 0.08, roughness: 0.5 }),
        );
        scene.add(mesh);
        frame();
        setStats({
          name: file.name,
          bytes: file.size,
          triangles: geometry.attributes.position.count / 3,
          size: [size.x, size.y, size.z],
        });
      } catch (e) {
        setPreviewError(`解析失败：${String((e as Error)?.message ?? e)}`);
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    const onResize = () => {
      const w = host.clientWidth || 480;
      const h = host.clientHeight || 320;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    let raf = 0;
    const loop = () => {
      if (disposed) return;
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      disposed = true;
      loadRef.current = null;
      cancelAnimationFrame(raf);
      ro.disconnect();
      disposeControls();
      if (mesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      renderer.dispose();
      // Without this, every open/close leaves a live WebGL context and the
      // browser's ~16-context cap turns into "Error creating WebGL context".
      renderer.forceContextLoss();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [open, background]);

  // Esc closes, like every other dialog in the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    // Deliberately does NOT touch the import path: the browser knows the FILE,
    // never its server path, and a name is not a path.
    void loadRef.current?.(file);
  };

  const submitImport = async () => {
    setImportError(null);
    setImportInfo(null);
    if (!project) {
      setImportError('会话工作目录还没解析出来，无法确定写进哪份语料。请等面板刷新后再试。');
      return;
    }
    if (!path.trim()) {
      setImportError('请填写该文件在服务器上的路径（相对会话目录或绝对路径）。');
      return;
    }
    setBusy(true);
    try {
      const req = buildImportStlRequest({ project, file: path, unit, part: partName, allowNonSolid });
      const res = await fetch(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch { /* plain-text error */ }
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? text ?? `HTTP ${res.status}`);
      if (!data?.versionId) throw new Error(text || '服务器没有返回 versionId');
      setImportInfo(
        `已登记 ${data.versionId} · ${data.watertight ? '水密' : '非实体'} · ` +
        `${data.triangles} 面 · ${(data.sizeMm ?? []).map((v: number) => Number(v).toFixed(1)).join(' × ')} mm`,
      );
      onImported(data.versionId);
    } catch (e) {
      setImportError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.panel} role="dialog" aria-modal="true" aria-label="本地 STL 文件">
        <div style={S.head}>
          <span style={S.title}>📂 本地 STL</span>
          <button type="button" style={S.tab(tab === 'preview')} onClick={() => setTab('preview')}>
            预览（不登记）
          </button>
          <button type="button" style={S.tab(tab === 'import')} onClick={() => setTab('import')}>
            导入为版本
          </button>
          <span style={{ ...S.hint, marginLeft: 6 }}>
            {tab === 'preview'
              ? '只在浏览器里看形状 — 不产生版本、不参与测量/装配、不进 Agent 上下文'
              : '把服务器上的文件登记成版本 — 面板、测量、装配与 Agent 都能用它'}
          </span>
          <button type="button" style={{ ...S.smallBtn, marginLeft: 'auto' }} onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        <div style={S.body}>
          {/* Both panes stay mounted: switching to 导入 and back must NOT tear
              down the WebGL context (a rebuild costs one, and the browser caps
              ~16) or silently lose the mesh while the stats still describe it. */}
          <div style={{
            display: tab === 'preview' ? 'flex' : 'none',
            flexDirection: 'column', gap: 8, flex: '1 1 auto', minHeight: 0,
          }}>
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none', flexWrap: 'wrap' }}>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".stl,model/stl,application/sla"
                  style={{ display: 'none' }}
                  onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
                />
                <button type="button" style={S.smallBtn} onClick={() => inputRef.current?.click()}>
                  选择 STL 文件…
                </button>
                {stats && (
                  <span style={{ fontSize: 12, color: '#3b4450', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {stats.name} · {stats.triangles} 面 · 包围盒 {stats.size.map((v) => v.toFixed(1)).join(' × ')}
                  </span>
                )}
                {loading && <span style={S.hint}>解析中…</span>}
                <span style={{ ...S.hint, marginLeft: 'auto' }}>拖入窗口也可以</span>
              </div>

              <div
                ref={hostRef}
                style={{
                  ...S.canvasHost,
                  outline: dragging ? '2px dashed #2f6fdb' : 'none',
                  outlineOffset: -4,
                }}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  pickFile(e.dataTransfer.files?.[0]);
                }}
              >
                {!stats && !previewError && (
                  <div style={{
                    position: 'absolute', inset: 0, zIndex: 2,
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: 6, pointerEvents: 'none',
                  }}>
                    <div style={{ fontSize: 26 }}>📦</div>
                    <div style={{ fontSize: 12, color: '#5b6673' }}>把 STL 拖到这里，或点「选择 STL 文件…」</div>
                    <div style={S.hint}>单位不做换算：STL 没有单位，预览只画文件里的数</div>
                  </div>
                )}
                {previewError && (
                  <div style={{
                    position: 'absolute', inset: 0, zIndex: 2,
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: 6, padding: 16, textAlign: 'center',
                  }}>
                    <div style={{ ...S.error, maxWidth: 520 }}>{previewError}</div>
                  </div>
                )}
              </div>

              {previewNote && <div style={S.hint}>{previewNote}</div>}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                <span style={{ ...S.hint, flex: '1 1 auto' }}>
                  预览不是证据：要量尺寸、装配或让 Agent 接着做，把它登记为版本。
                </span>
                <button
                  type="button"
                  style={S.primary}
                  onClick={() => {
                    if (stats && !partName) setPartName(stats.name.replace(/\.[^.]+$/, ''));
                    // Never prefill the PATH from a previewed file: the browser
                    // only knows its name, and "v021.stl" resolved against the
                    // session dir would import the wrong file (or none).
                    setImportHint(stats
                      ? `刚预览的是「${stats.name}」。浏览器没有把它的路径送到服务器——请填该文件在服务器上的真实路径。`
                      : '预览只在浏览器里；导入需要文件在服务器上的路径。');
                    setTab('import');
                  }}
                >
                  登记为版本…
                </button>
                <button type="button" style={S.smallBtn} onClick={onClose}>关闭</button>
              </div>
            </>
          </div>

          <div style={{
            display: tab === 'import' ? 'flex' : 'none',
            flexDirection: 'column', gap: 8, flex: '1 1 auto', minHeight: 0,
          }}>
            <>
              <div style={{ ...S.hint, lineHeight: 1.6 }}>
                浏览器拿不到本地文件的真实路径，所以这里填 <b>服务器上</b> 的路径（相对会话目录或绝对路径）。
                导入与 Agent 的 <code>import_part</code> 是同一条实现；成功后得到一个新版本。
              </div>

              <div style={{ ...S.ok, ...(project ? {} : S.error) }}>
                写入：<code>{project || '（会话工作目录未解析）'}</code>
                {!project && ' — 不能猜测目标语料，请等面板刷新后再试'}
              </div>

              {importHint && <div style={{ ...S.hint, color: '#8a6d1a' }}>{importHint}</div>}

              <label style={S.field}>
                <span style={{ flex: 'none', width: 64 }}>文件路径</span>
                <input
                  style={S.input}
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="例如 out/pan-45.stl 或 /home/me/models/pan.stl"
                  spellCheck={false}
                />
              </label>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ ...S.field, flex: 'none' }}>
                  <span style={{ flex: 'none' }}>单位</span>
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as ImportUnit)}
                    style={{ ...S.input, width: 150, flex: 'none' }}
                    title="STL 不携带单位，必须声明；选错会让零件整体差 10 倍或 25.4 倍"
                  >
                    {IMPORT_UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                  </select>
                </label>
                <label style={{ ...S.field, flex: '1 1 220px', minWidth: 180 }}>
                  <span style={{ flex: 'none' }}>零件名</span>
                  <input
                    style={S.input}
                    value={partName}
                    onChange={(e) => setPartName(e.target.value)}
                    placeholder={path.trim() ? partNameFromPath(path) : '默认取文件名'}
                  />
                </label>
              </div>

              <label style={{ ...S.field, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={allowNonSolid}
                  onChange={(e) => setAllowNonSolid(e.target.checked)}
                />
                <span>允许非实体网格（有孔/未闭合）。默认拒绝——存进去会让所有下游测量变成假数；勾选后该版本会被标记，几何工具会拒收。</span>
              </label>

              {importError && <div style={S.error}>{importError}</div>}
              {importInfo && <div style={S.ok}>{importInfo}</div>}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 'auto' }}>
                <span style={{ ...S.hint, flex: '1 1 auto' }}>
                  不渲染四张预览图（面板直接加载 model.stl），所以导入很快。
                </span>
                <button type="button" style={S.smallBtn} onClick={() => setTab('preview')}>去预览</button>
                <button
                  type="button"
                  style={{ ...S.primary, opacity: busy ? 0.6 : 1 }}
                  disabled={busy}
                  onClick={() => void submitImport()}
                >
                  {busy ? '导入中…' : '导入并登记'}
                </button>
              </div>
            </>
          </div>
        </div>
      </div>
    </div>
  );
}
