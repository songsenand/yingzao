// Byte-level download progress for a mesh, as a pure function.
//
// WHY THIS IS NOT INLINE IN THE PANEL: "a million-triangle STL shows nothing
// until it is done" is a claim about a stream, and the interesting half is what
// happens when the server does not say how big the body is, when the body ends
// early, or when a chunk arrives split across frames. That arithmetic is
// checkable without a browser (`scripts/accept-stream-progress.mjs`); a spinner
// buried in a 2,600-line React component is only checkable by waiting.
//
// The reader never buffers the whole body twice: chunks are kept as views and
// concatenated once at the end, and `onProgress` is called per chunk.

export interface Progress {
  /** Bytes received so far. */
  readonly done: number;
  /** Total bytes, or null when the server did not declare a length. */
  readonly total: number | null;
}

/** Bytes → the two numbers a progress bar needs, from a Content-Length header. */
export function totalFromHeader(header: string | null): number | null {
  if (!header) return null;
  const parsed = Number(header);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** `0..1`, or null when the total is unknown (a bar cannot invent a fraction). */
export function fraction(progress: Progress): number | null {
  if (progress.total === null || progress.total <= 0) return null;
  return Math.min(1, progress.done / progress.total);
}

/**
 * Drain a fetch Response body, reporting progress.
 *
 * Falls back to `arrayBuffer()` when the environment has no streaming body (or
 * when the response is already buffered): progress is then one final tick with
 * `done === total`, which is honest ("we cannot see inside this one") rather
 * than a fake animation.
 */
export async function readBodyWithProgress(
  response: { headers?: { get(name: string): string | null }; body?: ReadableStream<Uint8Array> | null; arrayBuffer(): Promise<ArrayBuffer> },
  onProgress?: (progress: Progress) => void,
  options?: { chunkBytes?: number },
): Promise<ArrayBuffer> {
  const total = totalFromHeader(response.headers?.get?.('content-length') ?? null);
  const body = response.body ?? null;
  if (!body || typeof (body as ReadableStream<Uint8Array>).getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    onProgress?.({ done: buffer.byteLength, total: total ?? buffer.byteLength });
    return buffer;
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const slices: Uint8Array[] = [];
  let done = 0;
  // One terminal tick, not two: the last chunk and the after-the-loop report
  // carry the same numbers, and a duplicated tick makes a caller re-render for
  // nothing (the test caught it: "…175/175 175/175").
  let reported = '';
  const emit = (progress: Progress) => {
    const key = `${progress.done}/${progress.total}`;
    if (key === reported) return;
    reported = key;
    onProgress?.(progress);
  };
  emit({ done, total });
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    if (!value || value.byteLength === 0) continue;
    slices.push(value);
    done += value.byteLength;
    emit({ done, total });
  }

  // ONE allocation at the end, in arrival order. A partial concat here (a
  // missing slice) is not detectable from the byte count alone, which is why the
  // test compares the BYTES, not only the length.
  const out = new Uint8Array(done);
  let at = 0;
  for (const slice of slices) {
    out.set(slice, at);
    at += slice.byteLength;
  }
  emit({ done, total: total ?? done });
  return out.buffer;
}
