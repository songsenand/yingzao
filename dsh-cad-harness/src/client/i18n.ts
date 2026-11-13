// Plan A localization: the high-traffic CAD surfaces get typed zh/en
// dictionaries; the DSH locale service owns browser/OS detection and the
// persisted Settings choice. Deep-panel copy stays Chinese until preview.2.
//
// Why a module-level translator: the export dialog and the project notices are
// plain functions called outside React. The panel subscribes to locale
// revisions so a language switch repaints without a reload.

import React from 'react';

export const NS = 'cad';

export const zh = {
  'tab.title': 'CAD 预览',

  'missing.blank': '预设没生效：本会话是「{preset}」 · 会话还没开始，现在重新选一次「{wanted}」还能生效',
  'missing.locked': '预设没生效：本会话以「{preset}」开始，已锁定 · 新建会话，或在设置里把「{wanted}」设为默认预设',
  'missing.unknown': '此会话没有 CAD 工具（预设「{preset}」不在开放列表里） · 新建会话并选「{wanted}」',

  'env.kernel': '几何内核「{kernel}」在这个版本不可用 · 运行 npx dsh-cad-backend --kernel openscad，然后重启 dsh',
  'env.failed': 'Python 运行时失败：{error} · 运行 python_runtime action=repair；仍失败就附上 dsh-cad-doctor --json',
  'env.disabled': 'Python 运行时被禁用（DSH_CAD_PYTHON=off）— 几何分析、物理与流体不可用 · unset DSH_CAD_PYTHON 后重启',
  'env.unsupported': 'Python 运行时在这个平台不可用（{kernel}）— 分析/仿真会拒绝运行 · 这不是建模失败',
  'env.absent': 'Python 运行时未就绪：首次分析/仿真会下载约 400 MB · 可让 Agent 先跑 python_runtime action=provision，或设置 DSH_CAD_PYTHON=eager',

  'export.title': '此版本未通过交付审计',
  'export.message': '文件名会带 _UNVERIFIED；导出记录会留在项目的 exports/ 下。',
  'export.more': '还有 {count} 条，见导出 manifest。',
  'export.next': '下一步：{items}',
  'export.reasonLabel': '确认原因（会写进导出记录）',
  'export.reasonDefault': '我已阅读上述风险，仍要导出',
  'export.ack': '我已阅读以上风险；我知道文件名和 manifest 会标注未验证，改名不会改变这一点。',
  'export.cancel': '取消',
  'export.confirm': '仍要导出（未验证）',
  'export.errorCode': '导出失败（{code}）：{hint}',
  'export.errorStatus': '导出失败（HTTP {status}）{detail}',
  'export.error': '导出失败：{message}',

  'panel.projectZip': '整机 ZIP (.zip)',
  'panel.projectZipTitle': '整个项目打包：每个零件的 STL + 装配清单 + 说明（有清单时另含按位姿摆好的 assembly.stl）',
  'panel.projectStl': '整机 STL (.stl)',
  'panel.projectStlTitle': '按 assembly.json 的 translate/rotate/pose 把各零件摆好后合并成一个多壳 STL（整机预览/报价用）',
  'panel.projectStlNoAssembly': '没有 assembly/assembly.json，无法按装配位置合并；请先用 ZIP 导出逐零件 STL',
  'panel.projectHintWithAssembly': '整个项目：全部零件 + 装配清单',
  'panel.projectHintNoAssembly': '整个项目：全部零件（尚无装配清单）',
  'panel.projectStlNote': '整机 STL 保留各零件自己的壳体，不做布尔并集；需要逐件打印或归档时用 ZIP。',
  'panel.exportGeometry': '下载当前版本的几何',
  'panel.exportGeometryTitle': '下载 {name}',
  'panel.projectLabel': '整个项目',
  'panel.unregistered': '📂 未登记文件：预览 / 导入',
  'panel.help': '这些按钮怎么用？',
  'panel.noParts': '还没有零件。让 Agent 生成一个零件（它会按声明的零件名归档），或在会话里跑一次验证。{project}',
  'panel.noRecords': '该零件还没有记录 — 让 Agent 迭代它，或跑一次验证。',
} as const;

export type CadKey = keyof typeof zh;

export const en: Record<CadKey, string> = {
  'tab.title': 'CAD preview',

  'missing.blank': 'Preset not active: this session is “{preset}” · It has not started yet, so re-selecting “{wanted}” now still works',
  'missing.locked': 'Preset not active: this session started as “{preset}” and is locked · Start a new session, or make “{wanted}” the default preset in Settings',
  'missing.unknown': 'This session has no CAD tools (preset “{preset}” is not in the open list) · Start a new session and select “{wanted}”',

  'env.kernel': 'Geometry kernel “{kernel}” is not available in this build · Run npx dsh-cad-backend --kernel openscad, then restart dsh',
  'env.failed': 'Python runtime failed: {error} · Run python_runtime action=repair; if it still fails, attach dsh-cad-doctor --json',
  'env.disabled': 'Python runtime is disabled (DSH_CAD_PYTHON=off) — geometry analysis, physics and fluid are unavailable · Unset DSH_CAD_PYTHON and restart',
  'env.unsupported': 'Python runtime is unavailable on this platform ({kernel}) — analysis/simulation will refuse to run · This is not a modelling failure',
  'env.absent': 'Python runtime is not ready: the first analysis/simulation downloads about 400 MB · Ask the agent to run python_runtime action=provision, or set DSH_CAD_PYTHON=eager',

  'export.title': 'This version did not pass the delivery audit',
  'export.message': 'The filename will carry _UNVERIFIED; an export record stays under the project exports/ directory.',
  'export.more': '{count} more finding(s); see the export manifest.',
  'export.next': 'Next: {items}',
  'export.reasonLabel': 'Reason (written to the export record)',
  'export.reasonDefault': 'I have read the risks and still want to export',
  'export.ack': 'I have read the risks; I understand the filename and manifest mark this as unverified, and renaming does not change that.',
  'export.cancel': 'Cancel',
  'export.confirm': 'Export anyway (unverified)',
  'export.errorCode': 'Export failed ({code}): {hint}',
  'export.errorStatus': 'Export failed (HTTP {status}){detail}',
  'export.error': 'Export failed: {message}',

  'panel.projectZip': 'Project ZIP (.zip)',
  'panel.projectZipTitle': 'Package the whole project: every part STL + assembly manifest + README (plus a placed assembly.stl when a manifest exists)',
  'panel.projectStl': 'Project STL (.stl)',
  'panel.projectStlTitle': 'Place every part by translate/rotate/pose from assembly.json and merge into one multi-shell STL (for whole-machine preview/quoting)',
  'panel.projectStlNoAssembly': 'No assembly/assembly.json, so parts cannot be placed; export per-part STLs with ZIP first',
  'panel.projectHintWithAssembly': 'Whole project: all parts + assembly manifest',
  'panel.projectHintNoAssembly': 'Whole project: all parts (no assembly manifest yet)',
  'panel.projectStlNote': 'The project STL keeps each part as its own shell; it is not a boolean union. Use ZIP for per-part printing or archiving.',
  'panel.exportGeometry': 'Download current version geometry',
  'panel.exportGeometryTitle': 'Download {name}',
  'panel.projectLabel': 'Whole project',
  'panel.unregistered': '📂 Unregistered files: preview / import',
  'panel.help': 'How do these buttons work?',
  'panel.noParts': 'No parts yet. Ask the agent to create one (it archives under the declared part name), or run a verification in the session.{project}',
  'panel.noRecords': 'This part has no records yet — ask the agent to iterate it, or run a verification.',
};

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`));
}

let translator: (key: string, vars?: Record<string, string | number>) => string =
  (key, vars) => interpolate((zh as Record<string, string>)[key] ?? key, vars);
let revision = 0;
const listeners = new Set<() => void>();

/** Translate a high-traffic CAD string. Missing keys fall back to the key. */
export function t(key: CadKey, vars?: Record<string, string | number>): string {
  return translator(key, vars);
}

/** Test seam / locale-registration seam. */
export function setCadTranslator(fn: (key: string, vars?: Record<string, string | number>) => string): void {
  translator = fn;
  revision++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Repaint the panel when the DSH locale changes. */
export function useLocaleRevision(): number {
  return React.useSyncExternalStore(subscribe, () => revision, () => revision);
}

/**
 * Register the CAD dictionaries and bind the module translator to the active
 * locale. The DSH locale service already resolves the browser/OS language and
 * persists the Settings choice; this function does not duplicate that logic.
 */
export function installCadLocale(ctx: any): void {
  if (!ctx?.locale?.register) return;
  ctx.effect(() => {
    const disposeZh = ctx.locale.register(NS, 'zh', zh);
    const disposeEn = ctx.locale.register(NS, 'en', en);
    const bind = () => setCadTranslator((key, vars) => ctx.locale.bind(NS)(key, vars));
    bind();
    const off = ctx.locale.subscribe(bind);
    return () => {
      off?.();
      disposeZh?.();
      disposeEn?.();
      setCadTranslator((key, vars) => interpolate((zh as Record<string, string>)[key] ?? key, vars));
    };
  }, 'cad-harness: locale dictionaries');
}
