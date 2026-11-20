// The first real geometry adapter. Its metadata lives in backend.ts; this module
// is the boundary the kernel registry calls. The adapter has ONE operation —
// compile — because rendering/export belong to the shared OpenSCAD path, not to
// each authoring engine.

import { compileOpenScad } from '../compile.ts';
import type { EngineAdapter } from '../backend.ts';

export const OPENSCAD_ADAPTER: EngineAdapter = {
  id: 'openscad',
  compile: async (source, opts) => await compileOpenScad(source, { render: opts?.render !== false }),
};
