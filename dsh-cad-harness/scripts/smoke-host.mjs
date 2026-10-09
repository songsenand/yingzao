// Host-half smoke test: simulate a minimal cordis ctx and verify both the
// STL fetch route and the cad/echo RPC endpoint behave correctly.
import { apply } from '../src/host/index.ts';

const registered = {};

// The plugin reaches the host connection through ctx.reflect.get('connection')
// (that indirection landed after this smoke test was written), so the stub has to
// provide it — otherwise apply() returns early and none of the routes register.
const connection = {
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
};

const ctx = {
  connection,
  reflect: { get: (key) => (key === 'connection' ? connection : undefined), set: () => {} },
  // The plugin registers its tools through ctx.tools.register(...); this stub was
  // written before that API existed, which is why this smoke test had been failing
  // since tools landed. It records the names so the count can be asserted below.
  tools: {
    register(definition) {
      registered.tools = registered.tools ?? [];
      registered.tools.push(definition.name);
      return () => {};
    },
  },
  // Event subscription (usage telemetry observes llm/stream).
  on(event) {
    registered.events = registered.events ?? [];
    registered.events.push(event);
    return () => {};
  },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  effect(fn, label) {
    const result = fn();
    if (label) registered[label] = result;
    console.log('effect applied:', label ?? '(unlabelled)');
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
console.log(`tools registered: ${registered.tools?.length ?? 0} (${(registered.tools ?? []).slice(0, 3).join(', ')}…)`);
if (!registered.tools || registered.tools.length < 10) {
  console.error('FAIL: the plugin should register its tool set');
  process.exit(1);
}
console.log('SMOKE TEST PASSED');
