// Download filenames: one rule for every file the browser saves.
//
// WHY THIS EXISTS. The export route used `model_<version>.stl`, and the run's
// per-part STL route sent no `Content-Disposition` at all — so a download landed
// as `stl` (or `model_v031.stl`) with no part name. The person holding the file
// then has to remember which part `v031` was, which is exactly the kind of
// identity the rest of the harness refuses to drop (shot captions, run titles).
//
// The rules:
//   * a part is named by its DISPLAY name, then the version id:
//     `碳原子 C_v031.stl`, `r098_B01.stl`;
//   * every path separator / control / reserved character becomes `_`; a stem
//     that is empty (or only dots) falls back to the caller's word;
//   * non-ASCII is legal in a filename, so `Content-Disposition` carries both an
//     ASCII `filename=` (for old clients) and an RFC 5987 `filename*=UTF-8''…`.
//
// Pure string work, so scripts/accept-download-names.mjs pins it without a server.

/** Characters no filesystem (or browser) should see in a downloaded stem. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
/**
 * Byte budget for a stem, leaving room for `.stl`/`.json`/`.png` under the
 * common 255-byte filename limit. Counted in UTF-8 BYTES, not characters: one
 * CJK character is three bytes, so a 120-character limit would still overflow.
 */
const MAX_STEM_BYTES = 200;

/** Cut at a code-point boundary without splitting a surrogate pair. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = '';
  for (const ch of text) {
    if (encoder.encode(out + ch).length > maxBytes) break;
    out += ch;
  }
  return out;
}

/**
 * One path component, safe to save. CJK is kept: it is the part's real name.
 * `fallback` is used when nothing usable survives (empty, `.`, `..`).
 */
export function safeFileStem(raw: string, fallback = 'model'): string {
  const cleaned = truncateUtf8(
    String(raw ?? '')
      .replace(ILLEGAL, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .trim(),
    MAX_STEM_BYTES,
  ).trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

/**
 * `<part>_<version>.<ext>` style name from already-meaningful parts.
 * Empty parts are skipped, so `[null, 'v031']` becomes `v031.stl`, not `_v031.stl`.
 */
export function downloadName(
  parts: readonly (string | null | undefined)[],
  ext: string,
  fallback = 'model',
): string {
  const stem = truncateUtf8(
    parts
      .map((p) => (p ? safeFileStem(p, '') : ''))
      .filter(Boolean)
      .join('_'),
    MAX_STEM_BYTES,
  ).replace(/[_\s]+$/, '');
  const suffix = String(ext).replace(/^\./, '').replace(/[^a-z0-9]/gi, '') || 'bin';
  return `${stem || safeFileStem(fallback, 'download')}.${suffix}`;
}

/**
 * `attachment; filename="ASCII"; filename*=UTF-8''…` — the browser prefers the
 * RFC 5987 form, so the saved file keeps the part's Chinese name. The ASCII form
 * is only a fallback; it must never contain a quote, backslash or newline.
 */
export function contentDisposition(filename: string): string {
  const safe = safeFileStem(filename, 'download');
  const asciiRaw = safe
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\"]/g, '_')
    .trim();
  // A pure-CJK name reduces to "" or ".stl"; a leading dot would save a hidden
  // file, so the ASCII form falls back to a plain word. Browsers use filename*.
  const ascii = asciiRaw && !asciiRaw.startsWith('.') ? asciiRaw : 'download';
  const encoded = encodeURIComponent(safe)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
