// Acceptance for the panel's local-STL import request (src/client/local-file-request.ts).
//
// The human-facing import must use the SAME door as the `import_part` tool
// (`POST /api/cad/import`), must target the SESSION corpus rather than whatever
// corpus the panel happens to be browsing, and must not spend four server-side
// renders the panel will never show.
//
//   node scripts/accept-local-stl.mjs

import {
  buildImportStlRequest, partNameFromPath, IMPORT_UNITS,
} from '../src/client/local-file-request.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const part = (p) => partNameFromPath(p);

check(IMPORT_UNITS[0]?.id === 'mm',
  'mm is the default unit in the picker (STL carries none; the human declares it)',
  IMPORT_UNITS.map((u) => u.id).join(','));

const base = buildImportStlRequest({
  project: '/work/my project', file: '  out/pan-45.stl  ', unit: 'mm',
});
check(base.url === `/api/cad/import?project=${encodeURIComponent('/work/my project')}`,
  'the import targets the session corpus (project is URL-encoded, spaces included)',
  base.url);
check(base.body.render === false,
  'render:false — the panel loads model.stl; it does not need four PNGs',
  JSON.stringify(base.body));
check(base.body.file === 'out/pan-45.stl',
  'the path is trimmed (a pasted path often carries a trailing space)',
  JSON.stringify(base.body.file));
check(base.body.unit === 'mm', 'the declared unit is sent verbatim');
check(!('part' in base.body),
  'a blank part name is OMITTED, so the server derives it from the file name');
check(!('allowNonSolid' in base.body),
  'allowNonSolid is omitted unless checked (non-solid is never the default)');

const named = buildImportStlRequest({
  project: '/w', file: 'a.step', unit: 'inch', part: '  托盘  ', allowNonSolid: true,
});
check(named.body.part === '托盘', 'a provided part name is trimmed and sent', JSON.stringify(named.body));
check(named.body.allowNonSolid === true, 'the explicit non-solid escape hatch is carried');
check(named.body.unit === 'inch', 'units other than mm are declarations too');

const dxf = buildImportStlRequest({ project: '/w', file: 'plate.dxf', unit: 'mm', depthMm: 10 });
check(dxf.body.depthMm === 10,
  'a DXF depth is carried (a profile is not a body without it)', JSON.stringify(dxf.body));
const noDepth = buildImportStlRequest({ project: '/w', file: 'plate.dxf', unit: 'mm', depthMm: 0 });
check(!('depthMm' in noDepth.body),
  'a non-positive depth is omitted, not sent as 0 (the server would reject it)');

const noProject = buildImportStlRequest({ project: '', file: 'x.stl', unit: 'mm' });
check(noProject.url === '/api/cad/import',
  'an unresolved session dir does not fabricate a project (the dialog refuses instead)',
  noProject.url);

check(part('out/pan-45.stl') === 'pan-45', 'part name comes from the file name (unix path)');
check(part('C:\\models\\pan 45.STL') === 'pan 45', '…and from a Windows path, case-insensitively');
check(part('  /a/b/c/  ') === '导入件', 'a path with no file name falls back to a visible default');

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
