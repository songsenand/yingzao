#!/usr/bin/env node
// C1a acceptance: the client dialog, exercised with a minimal DOM.
// No jsdom dependency: the dialog only needs createElement/append/events/focus.

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.style = {};
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.type = '';
    this.href = '';
    this.download = '';
    this.rel = '';
    this.attributes = {};
    this.clicked = false;
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  dispatch(type) { this.listeners.get(type)?.({ target: this }); }
  focus() {}
  click() { this.clicked = true; this.dispatch('click'); }
  setAttribute(name, value) { this.attributes[name] = value; }
}

const body = new FakeElement('body');
const created = [];
globalThis.document = {
  body,
  createElement: (tag) => { const el = new FakeElement(tag); created.push(el); return el; },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { location: { origin: 'http://x' }, alert: (msg) => { throw new Error(`unexpected alert: ${msg}`); } };
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};

const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  if (calls.length === 1) {
    return new Response(JSON.stringify({
      kind: 'export-blocked',
      verdict: 'blocked',
      message: 'blocked',
      findings: [{ severity: 'blocked', code: 'printability', detail: 'wall too thin' }],
      nextLook: ['fix the wall'],
    }), { status: 409, headers: { 'content-type': 'application/json' } });
  }
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { 'content-disposition': 'attachment; filename="part_v1_UNVERIFIED.stl"' },
  });
};

const { downloadExport } = await import('../src/client/export-gate.ts');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function walk(el, pred, out = []) {
  if (pred(el)) out.push(el);
  for (const child of el.children) walk(child, pred, out);
  return out;
}

const pending = downloadExport('http://x/api/cad/export?v=v1&format=stl');
await new Promise((resolve) => setTimeout(resolve, 0));

check('dialog blocks the first export', calls.length === 1);
check('dialog lists the finding', walk(body, (e) => e.textContent.includes('printability')).length > 0);
const checkbox = walk(body, (e) => e.type === 'checkbox')[0];
const buttons = walk(body, (e) => e.tagName === 'BUTTON');
const confirm = buttons.find((b) => b.textContent.includes('仍要导出'));
check('dialog has a checkbox', Boolean(checkbox));
check('dialog has a confirm button', Boolean(confirm));
check('confirm starts disabled', confirm?.disabled === true);

if (checkbox) {
  checkbox.checked = true;
  checkbox.dispatch('change');
}
check('confirm enables after acknowledgement', confirm?.disabled === false);
confirm?.click();

await pending;
check('second request carries confirm + reason', calls[1]?.includes('confirm=1') && calls[1]?.includes('reason='), calls[1] ?? '');
const anchor = created.find((e) => e.tagName === 'A');
check('download uses the server filename', anchor?.download === 'part_v1_UNVERIFIED.stl', anchor?.download ?? 'none');
check('anchor was clicked', anchor?.clicked === true);

console.log(`\naccept-export-dialog: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
