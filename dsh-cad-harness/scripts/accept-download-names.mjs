// Acceptance: a downloaded file says WHAT it is.
//
// The bug: `/api/cad/export` saved `model_v031.stl` (no part name), the run's
// per-part STL route sent no `Content-Disposition` at all (the browser named it
// `stl`), and screenshots saved as `cad-v031-装配静置视图.png` — the part's
// name was nowhere. A file is read out of context; `v031` does not say
// "碳原子 C".
//
//   node scripts/accept-download-names.mjs
import { contentDisposition, downloadName, safeFileStem } from '../src/shared/download-name.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ---- 1. part + version, in that order --------------------------------------
{
  check(downloadName(['碳原子 C', 'v031'], 'stl') === '碳原子 C_v031.stl',
    'a version export names the part and the version',
    downloadName(['碳原子 C', 'v031'], 'stl'));
  check(downloadName(['r098', 'B01'], 'stl') === 'r098_B01.stl',
    'a run STL names the run and the part',
    downloadName(['r098', 'B01'], 'stl'));
  check(downloadName([null, 'v031'], 'stl', 'model') === 'v031.stl',
    'a missing part name does not leave a leading underscore',
    downloadName([null, 'v031'], 'stl', 'model'));
  check(downloadName(['', ''], 'stl', 'model') === 'model.stl',
    'no identity falls back to the caller word',
    downloadName(['', ''], 'stl', 'model'));
}

// ---- 2. one path component, no traversal -----------------------------------
{
  const evil = safeFileStem('../etc/passwd');
  check(!evil.includes('/') && !evil.includes('\\') && !evil.includes('..'),
    'path separators and dot-dot cannot survive', evil);
  const reserved = safeFileStem('a/b:c*?"<>|');
  check(!/[\\/:*?"<>|]/.test(reserved), 'reserved characters are replaced', reserved);
  check(safeFileStem('  ...  ') === 'model', 'a stem of only dots/spaces falls back', safeFileStem('  ...  '));
  check(safeFileStem('碳原子 C') === '碳原子 C', 'CJK is kept — it is the real name', safeFileStem('碳原子 C'));
}

// ---- 3. Content-Disposition: ASCII fallback + RFC 5987 ----------------------
{
  const cd = contentDisposition('碳原子 C_v031.stl');
  check(cd.startsWith('attachment; '), 'it is an attachment', cd);
  check(cd.includes('filename="C_v031.stl"'), 'the ASCII fallback drops CJK but keeps the version', cd);
  check(/filename\*=UTF-8''%E7%A2%B3/.test(cd), 'the RFC 5987 form carries the Chinese name', cd);
  check(!cd.slice(cd.indexOf('filename*=')).includes('"'),
    'the encoded form has no quote that would end the header early', cd);

  const ascii = contentDisposition('r098_B01.stl');
  check(ascii.includes('filename="r098_B01.stl"'), 'an ASCII name is passed through', ascii);

  const pureCjk = contentDisposition('碳原子.stl');
  check(pureCjk.includes('filename="download"'), 'a pure-CJK name does not become a hidden ".stl" file', pureCjk);
}

// ---- 4. length is bounded ---------------------------------------------------
{
  const long = downloadName(['零件'.repeat(80), 'v031'], 'stl');
  const bytes = new TextEncoder().encode(long).length;
  check(bytes <= 255, 'a long title is truncated in BYTES, not characters (CJK is 3 bytes each)',
    `${bytes} bytes / ${long.length} chars`);
  check(long.endsWith('.stl'), 'the extension survives truncation', long.slice(-4));
}

// ---- 5. the actual bug strings ---------------------------------------------
{
  check(downloadName(['碳原子 C', 'v031'], 'stl') !== 'model_v031.stl',
    'the old `model_<v>` name is gone');
  check(downloadName(['r098', 'B01'], 'stl') !== 'stl', 'the old extension-less run name is gone');
}

console.log(failures ? `\n${failures} FAIL` : '\nall PASS');
process.exit(failures ? 1 : 0);
