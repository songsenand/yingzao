// Pure request/data helpers for the panel's local-STL dialog.
//
// Separate from local-file.tsx so they can be imported by a Node acceptance
// script: Node strips types but does NOT transform JSX, so anything a test
// needs must live in a .ts module.

export type ImportUnit = 'mm' | 'cm' | 'm' | 'inch';

/** STL carries no unit, so this is a DECLARATION the human makes, not an inference. */
export const IMPORT_UNITS: { id: ImportUnit; label: string }[] = [
  { id: 'mm', label: 'mm（毫米，默认）' },
  { id: 'cm', label: 'cm（厘米）' },
  { id: 'm', label: 'm（米）' },
  { id: 'inch', label: 'inch（英寸）' },
];

export interface ImportStlRequestInput {
  /** Session working directory — the corpus the import lands in. */
  project: string;
  file: string;
  unit: ImportUnit;
  part?: string;
  allowNonSolid?: boolean;
  /** DXF only: a 2D profile becomes a solid when extruded by this many mm. */
  depthMm?: number;
}

export interface ImportStlRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * The request the panel sends to the SAME door the `import_part` tool uses.
 *
 * `render: false` on purpose: the panel loads `versions/vNNN/model.stl` straight
 * into the viewport, so four server-rendered PNGs would only add seconds and
 * disk. (The agent's `import_part` defaults to true because IT sees the images.)
 */
export function buildImportStlRequest(input: ImportStlRequestInput): ImportStlRequest {
  const file = input.file.trim();
  const part = (input.part ?? '').trim();
  const depth = input.depthMm;
  return {
    url: `/api/cad/import${input.project ? `?project=${encodeURIComponent(input.project)}` : ''}`,
    body: {
      file,
      unit: input.unit,
      ...(part ? { part } : {}),
      ...(input.allowNonSolid ? { allowNonSolid: true } : {}),
      ...(typeof depth === 'number' && Number.isFinite(depth) && depth > 0 ? { depthMm: depth } : {}),
      render: false,
    },
  };
}

/** The name the part gets unless the human overrides it (matches import_part). */
export function partNameFromPath(path: string): string {
  const base = path.trim().split(/[\\/]/).pop() ?? '';
  return base.replace(/\.[^.]+$/, '') || '导入件';
}
