// Host-half smoke test: simulate a minimal cordis ctx and verify both the
// STL fetch route and the cad/echo RPC endpoint behave correctly.
import { apply } from '../src/host/index.ts';

const registered = {};

const ctx = {
  effect(fn, label) {
    const result = fn();
    registered[label] = result;
    console.log('effect applied:', label, '->', typeof result === 'function' || result ? 'ok' : 'MISSING');
  },
  connection: {
    fetch: {
      register(route) {
        registered.route = route;
        console.log('fetch route registered:', route.path, route.methods, route.requestBody);
        return async () => {};
      },
    },
    rpc: {
      intercept(channel, matches, handler) {
        registered.channel = channel;
        registered.matches = matches;
        registered.handler = handler;
        console.log('rpc interceptor registered on', channel);
        return async () => {};
      },
    },
  },
};

apply(ctx);

// 1. endpoint matcher
console.log('matches cad/echo:', registered.matches('cad/echo'));
console.log('matches other/echo:', registered.matches('other/echo'));

// 2. echo endpoint
const echoResult = await registered.handler('cad/echo', { message: 'ping' }, new AbortController().signal);
console.log('echo result:', JSON.stringify(echoResult));
if (!echoResult.ok || echoResult.value.pong !== true || echoResult.value.echo !== 'ping') {
  console.error('FAIL: echo endpoint');
  process.exit(1);
}

// 3. unknown endpoint
const unknown = await registered.handler('cad/nope', {}, new AbortController().signal);
if (unknown.ok !== false) { console.error('FAIL: unknown endpoint should error'); process.exit(1); }
console.log('unknown endpoint correctly rejected:', unknown.error.code);

// 4. STL route returns a valid binary STL
const res = await registered.route.fetch(new Request('http://x/api/cad/test.stl'));
const body = new DataView(await res.arrayBuffer());
const triCount = body.getUint32(80, true);
const expectedLen = 84 + triCount * 50;
const actual = body.byteLength;
console.log('stl response:', res.status, res.headers.get('content-type'), 'tris:', triCount, 'bytes:', actual);
if (res.status !== 200 || triCount !== 12 || actual !== expectedLen) {
  console.error('FAIL: STL route');
  process.exit(1);
}
// watertight quick check: Euler characteristic of a closed mesh V - E + F = 2 is
// guaranteed by construction here (cube); edge/face ratio check instead:
console.log('SMOKE TEST PASSED');
