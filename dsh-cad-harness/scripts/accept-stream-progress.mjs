// U21 acceptance — byte progress for a mesh download, and the honest fallbacks.
//
// "A million-triangle STL shows nothing until it is done" is a claim about a
// STREAM. The interesting cases are the ones a spinner never tells you about:
// a body with no Content-Length, a response that arrives already buffered, an
// empty body, and a stream that errors halfway. All of them are checked here
// against synthetic bodies whose bytes are known exactly.
//
//   node scripts/accept-stream-progress.mjs

import { fraction, readBodyWithProgress, totalFromHeader } from '../src/client/stream-progress.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

/** A body that yields the given chunks, optionally erroring after them. */
function bodyOf(chunks, { failAfter = -1 } = {}) {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index === failAfter) throw new Error('connection reset mid-body');
          if (index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[index++] };
        },
      };
    },
  };
}
const bytes = (n, fill = 7) => new Uint8Array(n).fill(fill);
const response = (body, contentLength = null) => ({
  headers: { get: (name) => (name.toLowerCase() === 'content-length' ? contentLength : null) },
  body,
  arrayBuffer: async () => new ArrayBuffer(0),
});

console.log('stream progress acceptance\n');

// ── 1. header parsing ───────────────────────────────────────────────────────
check(totalFromHeader('1048576') === 1048576, 'a numeric Content-Length parses');
check(totalFromHeader(null) === null, 'no header → unknown total');
check(totalFromHeader('not-a-number') === null, 'a garbage header is unknown, not NaN');
check(totalFromHeader('-5') === null, 'a negative length is rejected');

// ── 2. progress ticks in arrival order ──────────────────────────────────────
{
  const ticks = [];
  const body = bodyOf([bytes(100), bytes(50), bytes(25)]);
  const buffer = await readBodyWithProgress(response(body, '175'), (p) => ticks.push(`${p.done}/${p.total}`));
  check(buffer.byteLength === 175, 'the concatenated body has every byte', String(buffer.byteLength));
  check(ticks.join(' ') === '0/175 100/175 150/175 175/175',
    'progress ticks accumulate and carry the declared total', ticks.join(' '));
  const view = new Uint8Array(buffer);
  check(view.every((byte) => byte === 7), 'the bytes are intact (not a length-only check)');
}

// ── 3. no Content-Length: done still accumulates, fraction is null ──────────
{
  const ticks = [];
  const buffer = await readBodyWithProgress(response(bodyOf([bytes(10), bytes(40)])), (p) => ticks.push(p));
  check(buffer.byteLength === 50, 'an unknown-length body still concatenates', String(buffer.byteLength));
  check(ticks[ticks.length - 1].total === 50 && ticks[ticks.length - 1].done === 50,
    'the final tick reports the length we actually got', JSON.stringify(ticks[ticks.length - 1]));
  check(ticks[1].total === null && fraction(ticks[1]) === null,
    'mid-stream with no header: total unknown, so no invented fraction');
  check(fraction({ done: 50, total: 200 }) === 0.25, 'fraction is done/total');
  check(fraction({ done: 300, total: 200 }) === 1, 'fraction saturates at 1');
  check(fraction({ done: 10, total: 0 }) === null, 'a zero total cannot divide');
}

// ── 4. buffered responses (no stream) still report once ─────────────────────
{
  const ticks = [];
  const buffered = {
    headers: { get: () => '4096' },
    body: null,
    arrayBuffer: async () => new Uint8Array(4096).buffer,
  };
  const buffer = await readBodyWithProgress(buffered, (p) => ticks.push(p));
  check(buffer.byteLength === 4096 && ticks.length === 1 && ticks[0].done === 4096,
    'a non-streaming response reports one final tick', JSON.stringify(ticks));
}

// ── 5. empty body ───────────────────────────────────────────────────────────
{
  const ticks = [];
  const buffer = await readBodyWithProgress(response(bodyOf([]), '0'), (p) => ticks.push(p));
  check(buffer.byteLength === 0, 'an empty body yields an empty buffer');
  check(ticks.length === 1 && ticks[0].done === 0 && ticks[0].total === 0,
    'an empty body ticks once with 0 bytes, no NaN and no duplicate', JSON.stringify(ticks));
}

// ── 6. a stream error must propagate ────────────────────────────────────────
{
  let message = '';
  try {
    await readBodyWithProgress(response(bodyOf([bytes(10), bytes(10)], { failAfter: 1 })));
  } catch (error) {
    message = String(error?.message ?? error);
  }
  check(/connection reset/.test(message),
    'a mid-body error rejects instead of returning a short buffer', message);
}

console.log(failures ? `\naccept-stream-progress: ${failures} FAILURE(S)` : '\naccept-stream-progress: PASS');
process.exit(failures ? 1 : 0);
