#!/usr/bin/env node
// Hermetic tests for the official-first / mirror-fallback download policy.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assetFor, downloadWithFallback, readBackendConfig, sourcesFor } from './provision-lib.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const good = Buffer.alloc(64 * 1024, 7);
const bad = Buffer.alloc(64 * 1024, 9);

const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/official-fast') {
    res.writeHead(200, { 'content-length': good.length, 'content-type': 'application/octet-stream' });
    res.end(good);
  } else if (req.url === '/official-bad') {
    res.writeHead(200, { 'content-length': bad.length, 'content-type': 'application/octet-stream' });
    res.end(bad);
  } else if (req.url === '/official-404') {
    res.writeHead(404); res.end('no');
  } else if (req.url === '/official-slow') {
    res.writeHead(200, { 'content-length': good.length, 'content-type': 'application/octet-stream' });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= good.length) { clearInterval(timer); res.end(); return; }
      res.write(good.subarray(sent, sent + 1024)); sent += 1024;
    }, 100);
    req.on('close', () => clearInterval(timer));
  } else if (req.url === '/mirror') {
    res.writeHead(200, { 'content-length': good.length, 'content-type': 'application/octet-stream' });
    res.end(good);
  } else {
    res.writeHead(500); res.end('boom');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const tmp = mkdtempSync(join(tmpdir(), 'cad-provision-'));

const opts = { startTimeoutMs: 300, sampleMs: 250, minBytesPerSec: 20 * 1024, idleTimeoutMs: 1200 };

try {
  // 1. official is slow -> mirror wins
  {
    const out = join(tmp, 'slow.bin');
    const logs = [];
    const result = await downloadWithFallback({
      sources: [{ label: 'official', url: `${base}/official-slow` }, { label: 'mirror', url: `${base}/mirror` }],
      expectedSha: sha(good), size: good.length, dest: out, ...opts, log: (line) => logs.push(line),
    });
    check('slow official falls back to mirror', result.source === 'mirror', result.source);
    check('fallback file matches', readFileSync(out).equals(good));
    check('fallback log names the reason', logs.some((l) => l.includes('official') && l.includes('too slow')), logs.join(' | '));
  }

  // 2. official 404 -> mirror
  {
    const out = join(tmp, '404.bin');
    const result = await downloadWithFallback({
      sources: [{ label: 'official', url: `${base}/official-404` }, { label: 'mirror', url: `${base}/mirror` }],
      expectedSha: sha(good), size: good.length, dest: out, ...opts,
    });
    check('HTTP 404 falls back to mirror', result.source === 'mirror', result.source);
  }

  // 3. official hash mismatch -> mirror
  {
    const out = join(tmp, 'bad.bin');
    const result = await downloadWithFallback({
      sources: [{ label: 'official', url: `${base}/official-bad` }, { label: 'mirror', url: `${base}/mirror` }],
      expectedSha: sha(good), size: good.length, dest: out, ...opts,
    });
    check('hash mismatch falls back to mirror', result.source === 'mirror', result.source);
    check('mirror bytes win', readFileSync(out).equals(good));
  }

  // 4. official is fast -> mirror is never touched
  {
    requests.length = 0;
    const out = join(tmp, 'fast.bin');
    const result = await downloadWithFallback({
      sources: [{ label: 'official', url: `${base}/official-fast` }, { label: 'mirror', url: `${base}/mirror` }],
      expectedSha: sha(good), size: good.length, dest: out, ...opts,
    });
    check('fast official is used', result.source === 'official', result.source);
    check('mirror not requested when official is fast', !requests.includes('/mirror'), requests.join(','));
  }

  // 5. both fail -> error names both
  {
    const out = join(tmp, 'fail.bin');
    let message = '';
    try {
      await downloadWithFallback({
        sources: [{ label: 'official', url: `${base}/official-404` }, { label: 'mirror', url: `${base}/mirror-500` }],
        expectedSha: sha(good), size: good.length, dest: out, ...opts,
      });
    } catch (error) { message = String(error?.message ?? error); }
    check('both failures are reported', message.includes('official') && message.includes('mirror'), message);
  }

  // 6. manifest order and platform mapping
  {
    const asset = assetFor('win32');
    const sources = sourcesFor(asset);
    check('manifest has all three platforms', Boolean(assetFor('win32') && assetFor('linux') && assetFor('darwin')));
    check('auto order is official then mirror', sources[0].label === 'official' && sources[1].label === 'mirror');
    check('mirror URL is the OSS prefix', sources[1].url.includes('blog-songsenand.oss-cn-hangzhou.aliyuncs.com'));
    check('unsupported platform is null', assetFor('aix') === null);
  }

  // 7. backend config preserves unrelated fields
  {
    const home = join(tmp, 'home');
    const dir = join(home, 'cad');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'backend.json'), JSON.stringify({ kernel: 'openscad', compileBackend: 'cgal', binaryPath: null }));
    const cfg = readBackendConfig(home);
    check('backend config preserves compileBackend', cfg.compileBackend === 'cgal');
    check('backend config reads binaryPath', cfg.binaryPath === null);

    const stub = join(tmp, 'openscad');
    writeFileSync(stub, '#!/bin/sh\necho "OpenSCAD version 2025.12.30"\n');
    chmodSync(stub, 0o755);
    writeFileSync(join(dir, 'backend.json'), JSON.stringify({ kernel: 'openscad', compileBackend: 'auto', binaryPath: stub }));
    const doctor = spawnSync(process.execPath, [new URL('./doctor.mjs', import.meta.url).pathname, '--json'], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, DSH_HOME: home },
    });
    let report = null;
    try { report = JSON.parse(doctor.stdout); } catch { /* assert below */ }
    const openscadCheck = report?.checks?.find((c) => c.id === 'openscad');
    check('doctor honors provisioned binaryPath', openscadCheck?.status === 'pass', openscadCheck?.detail);
  }
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\naccept-provision: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
