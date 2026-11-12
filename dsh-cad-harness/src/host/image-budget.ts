// Image-budget constants and the telemetry mirror (DESIGN §16–17).
//
// POLICY (user decision, 2026-10-03): standard-mode sessions run on dsh
// FACTORY DEFAULTS — no route-level budget is patched or written by this
// plugin. The only active budget is the per-SESSION window for 营造模式 (cad)
// sessions, enforced by the protected offload executor (image-offload.ts):
// 24 retained images, user-message top-level images exempt. The deepseek
// constants below therefore describe the cad WINDOW (and the adapter knobs
// a user may set themselves), not an applied route config.
//
// History: this module once wrote a pi-ai `maxRequestImageBytes` at boot
// (2.5 MiB, then 256 KiB) and claimed a `maxRequestImages` knob that never
// existed in any installed dsh — both removed. See DESIGN §14–§16.

/** Retained images for a 营造模式 session; mirrors the deepseek count budget. */
export const DEEPSEEK_KEEP_IMAGES = 24;
/** Removal step; mirrors `imageOffloadCountQuantum` (2 render rounds of 4 views). */
export const DEEPSEEK_COUNT_QUANTUM = 8;

/**
 * How many leading image occurrences a request projection removes.
 *
 * A local mirror of `offloadedImagePrefixCount()` from `@deepseek-ai/dsh-llm`,
 * which this plugin cannot import (that package is a sibling bundle, not one of
 * our dependencies). Used ONLY for telemetry and the cad-window arithmetic.
 * `scripts/accept-image-budget.mjs` checks this mirror against the real
 * function over a matrix of counts and quanta, so the reported numbers cannot
 * silently drift from what the provider receives.
 *
 * @param lengths - represented byte length of every occurrence, in request
 *   order. "Represented" matters: the DeepSeek route accounts raw attachment
 *   bytes, the pi-ai route accounts base64 length. Convert before calling.
 * @param maxImages - count budget; `undefined` leaves it unbounded.
 * @param maxBytes - byte budget; `undefined` leaves it unbounded.
 * @param countQuantum - excess count removed as one step.
 * @param byteQuantum - excess bytes removed as one step.
 * @returns how many leading occurrences the projection replaces.
 */
export function offloadedPrefixCount(
  lengths: readonly number[],
  maxImages: number | undefined,
  maxBytes: number | undefined,
  countQuantum = 1,
  byteQuantum = 1,
): number {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0);
  const excessCount = maxImages === undefined ? 0 : Math.max(0, lengths.length - maxImages);
  const excessBytes = maxBytes === undefined ? 0 : Math.max(0, total - maxBytes);
  if (excessCount === 0 && excessBytes === 0) return 0;
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum;
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum;
  let count = 0;
  let removedBytes = 0;
  for (const imageBytes of lengths) {
    const done = count >= removeCount
      && (removeBytes === 0 || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes));
    if (done) break;
    removedBytes += imageBytes;
    count += 1;
  }
  return count;
}
