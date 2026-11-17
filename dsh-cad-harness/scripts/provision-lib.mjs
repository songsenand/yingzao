// Download policy for the OpenSCAD runtime: official snapshot first, mirror only
// when the official source is unreachable or too slow.
//
// A "slow" official source is aborted after a short sample, so the user does not
// pay for a 40 MB download that is already visibly failing. The mirror restarts
// from byte 0; correctness is decided by SHA256, never by which host answered.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createWriteStream, readFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { basename, join } from 'node:path';

// The pinned snapshot is the build the mirror carries and every user installs.
// It was chosen without a special reason, so treat the pin as provisional:
// moving it means (1) fetching the three official archives, (2) updating ASSET
// below, (3) `node scripts/build-mirror-manifest.mjs`, (4) uploading the
// archives plus the manifest to the mirror. Upstream measured ~12.5 KB/s from
// the mirror's region, which is why the mirror exists — fetch the archives from
// a faster link rather than from files.openscad.org.
export const OPENSCAD_VERSION = '2025.12.30';
const OFFICIAL = 'https://files.openscad.org/snapshots';
const DEFAULT_MIRROR = 'https://blog-songsenand.oss-cn-hangzhou.aliyuncs.com/openscad/2025.12.30';

// A private or regional mirror is a deployment fact, not a code change: an
// enterprise intranet, a caching proxy, or a faster region points this at its
// own copy of the SAME pinned bytes. The sha256 below still decides, so a
// wrong mirror fails loudly instead of installing something else.
export function mirrorBase(env = process.env) {
  const raw = env.CAD_OPENSCAD_MIRROR?.trim();
  if (!raw) return DEFAULT_MIRROR;
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error('CAD_OPENSCAD_MIRROR must be an http(s) URL');
  }
  return raw.replace(/\/+$/, '');
}
const ASSET = {
  'OpenSCAD-2025.12.30-x86-64.zip': {
    platform: 'win32', archive: 'zip', sha256: 'f04d315b1f1fbe20b363383f45ea8ed65713fe9913b4368d90a94175b71423cb', size: 41511427,
  },
  'OpenSCAD-2025.12.30.ai30275-x86_64.AppImage': {
    platform: 'linux', archive: 'appimage', sha256: '380836a0dac0321d0b6d7f057266dc40ab6f8e35884587f07af5a38e80f6c65c', size: 84621816,
  },
  'OpenSCAD-2025.12.30.dmg': {
    platform: 'darwin', archive: 'dmg', sha256: 'fbc17e223979884fc17a4bc19b76a50c8797646cbc2f3083cd407389d90a1060', size: 62687889,
  },
};

export function assetFor(platform = process.platform, env = process.env) {
  const found = Object.entries(ASSET).find(([, v]) => v.platform === platform);
  if (!found) return null;
  const [filename, meta] = found;
  return {
    filename,
    ...meta,
    official: `${OFFICIAL}/${filename}`,
    mirror: `${mirrorBase(env)}/${filename}`,
  };
}

// Measured on one real model (experiments/20261021_openscad_text_engraving.md §5):
// the same plate.scad takes 2467 ms on the 2021.01 CGAL build and 69 ms on a
// Manifold build. That ratio, not the download source, is why the pinned
// snapshot matters — keep it in one place so doctor and provision agree.
export const SPEED_NOTE = '2467 ms vs 69 ms on the same plate.scad (2021.01 CGAL vs Manifold build)';

export function sourcesFor(asset, mode = 'auto') {
  if (mode === 'official') return [{ label: 'official', url: asset.official }];
  if (mode === 'mirror') return [{ label: 'mirror', url: asset.mirror }];
  return [
    { label: 'official', url: asset.official },
    { label: 'mirror', url: asset.mirror },
  ];
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Stream one URL to a file, aborting if it has no first byte, stalls, or its
// first sample is below minBytesPerSec. The caller decides whether to fall back.
export async function downloadToFile(url, dest, {
  startTimeoutMs = 8000,
  sampleMs = 5000,
  minBytesPerSec = 256 * 1024,
  idleTimeoutMs = 15000,
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  const controller = new AbortController();
  let firstByteTimer;
  let idleTimer;
  let sampleTimer;
  const fail = (message) => {
    const error = new Error(message);
    error.code = 'download_failed';
    controller.abort(error);
    throw error;
  };

  firstByteTimer = setTimeout(() => {
    controller.abort(new Error(`no first byte within ${startTimeoutMs} ms`));
  }, startTimeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'yingzao-openscad-provision/0.1' },
    });
  } catch (error) {
    clearTimeout(firstByteTimer);
    throw new Error(`request failed: ${String(error?.message ?? error)}`);
  }
  if (!response.ok) {
    clearTimeout(firstByteTimer);
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body) {
    clearTimeout(firstByteTimer);
    throw new Error('empty response body');
  }

  await mkdir(dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  const reader = response.body.getReader();
  let bytes = 0;
  let firstAt = 0;
  let sampled = false;
  let finished = false;

  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error(`stalled for ${idleTimeoutMs} ms`)), idleTimeoutMs);
  };

  try {
    resetIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      clearTimeout(firstByteTimer);
      resetIdle();
      if (!firstAt) {
        firstAt = Date.now();
        sampleTimer = setTimeout(() => {
          if (sampled) return;
          const seconds = Math.max(0.25, (Date.now() - firstAt) / 1000);
          const speed = bytes / seconds;
          if (speed < minBytesPerSec) controller.abort(new Error(`official too slow: ${Math.round(speed / 1024)} KB/s`));
        }, sampleMs);
      }
      bytes += value.byteLength;
      if (!out.write(Buffer.from(value))) await new Promise((resolve) => out.once('drain', resolve));
      if (firstAt && !sampled && Date.now() - firstAt >= sampleMs) {
        sampled = true;
        clearTimeout(sampleTimer);
        const seconds = (Date.now() - firstAt) / 1000;
        const speed = bytes / seconds;
        if (speed < minBytesPerSec) fail(`too slow: ${Math.round(speed / 1024)} KB/s`);
      }
    }
    await new Promise((resolve, reject) => out.end((error) => error ? reject(error) : resolve()));
    clearTimeout(firstByteTimer);
    clearTimeout(idleTimer);
    clearTimeout(sampleTimer);
    return { bytes, finished };
  } catch (error) {
    clearTimeout(firstByteTimer);
    clearTimeout(idleTimer);
    clearTimeout(sampleTimer);
    out.destroy();
    try { unlinkSync(dest); } catch { /* already gone */ }
    throw error;
  }
}

// Try sources in order. A source wins only when its bytes match expectedSha.
// Every failed attempt is named in the final error so "why did it use OSS?" is
// answerable from the message, not from a hidden fallback.
export async function downloadWithFallback({ sources, expectedSha, dest, size, ...opts }) {
  const temp = `${dest}.part`;
  const errors = [];
  for (const source of sources) {
    try {
      const result = await downloadToFile(source.url, temp, opts);
      if (size && result.bytes !== size) throw new Error(`size ${result.bytes} != ${size}`);
      if (expectedSha) {
        const actual = await sha256File(temp);
        if (actual !== expectedSha) throw new Error(`sha256 ${actual.slice(0, 12)}… != ${expectedSha.slice(0, 12)}…`);
      }
      renameSync(temp, dest);
      return { source: source.label, url: source.url, bytes: result.bytes };
    } catch (error) {
      const reason = String(error?.message ?? error);
      errors.push(`${source.label}: ${reason}`);
      opts.log?.(`${source.label} failed: ${reason}; trying next source`);
      try { unlinkSync(temp); } catch { /* absent */ }
    }
  }
  const error = new Error(`OpenSCAD download failed — ${errors.join('; ')}`);
  error.code = 'provision_failed';
  throw error;
}

export function readBackendConfig(home) {
  const path = join(home, 'cad', 'backend.json');
  if (!existsSync(path)) return { kernel: 'openscad', compileBackend: 'auto', binaryPath: null };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return {
      kernel: raw.kernel === 'openscad' ? 'openscad' : 'openscad',
      compileBackend: ['auto', 'manifold', 'cgal'].includes(raw.compileBackend) ? raw.compileBackend : 'auto',
      binaryPath: typeof raw.binaryPath === 'string' ? raw.binaryPath : null,
    };
  } catch {
    return { kernel: 'openscad', compileBackend: 'auto', binaryPath: null };
  }
}
