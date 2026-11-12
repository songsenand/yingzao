// The first real geometry adapter. Its metadata lives in backend.ts; this module
// is the boundary that the future kernel registry can call without knowing
// whether the implementation is OpenSCAD, CadQuery, or something else.

import { compileAndRenderOpenScad, exportScad, renderScadPng, type CompileResult } from '../compile.ts';
import { OPENSCAD_BACKEND, type CadBackend } from '../backend.ts';

export const OPENSCAD_ADAPTER: CadBackend = {
  ...OPENSCAD_BACKEND,
  compile: async (source: string): Promise<CompileResult> => await compileAndRenderOpenScad(source),
  render: async (sourcePath: string, pngPath: string, opts: unknown): Promise<boolean> =>
    await renderScadPng(sourcePath, pngPath, opts as Parameters<typeof renderScadPng>[2]),
  export: async (sourcePath: string, outPath: string, format: string): Promise<Uint8Array> =>
    await exportScad(sourcePath, outPath, format),
};
