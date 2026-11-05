// Map a pearl's probe slot to a registered checker directory.
//
// Probes are data + files, not tools. The pearl declares an allowlist; this module
// resolves one by id, pins its version, and verifies its negative samples before mount.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadChecker, verifyChecker, type LoadedChecker, type CheckerSelfTest } from '../checkers/registry.ts';
import type { PearlManifest } from './types.ts';

interface ProbeRegistry {
  schemaVersion: 1;
  probes: Record<string, { path: string; version: string }>;
}

export async function loadProbeRegistry(pearlsRoot: string): Promise<ProbeRegistry> {
  const raw = JSON.parse(await readFile(join(pearlsRoot, 'probes.json'), 'utf8')) as ProbeRegistry;
  if (raw.schemaVersion !== 1 || typeof raw.probes !== 'object' || raw.probes === null) {
    throw new Error('probes.json must be { schemaVersion: 1, probes: {...} }');
  }
  return raw;
}

export async function mountProbe(
  pearl: PearlManifest,
  probeId: string,
  pearlsRoot: string,
): Promise<{ checker: LoadedChecker; selfTest: CheckerSelfTest }> {
  if (!pearl.probe.allowed.includes(probeId)) {
    throw new Error(`probe "${probeId}" is not allowed by pearl "${pearl.id}" (allowed: ${pearl.probe.allowed.join(', ')})`);
  }
  const registry = await loadProbeRegistry(pearlsRoot);
  const entry = registry.probes[probeId];
  if (!entry) throw new Error(`probe "${probeId}" is not registered in probes.json`);
  const dir = resolve(pearlsRoot, entry.path);
  const checker = await loadChecker(dir);
  if (checker.manifest.version !== entry.version) {
    throw new Error(`probe "${probeId}" version mismatch: registry ${entry.version}, manifest ${checker.manifest.version}`);
  }
  if (checker.manifest.pearl !== pearl.id) {
    throw new Error(`probe "${probeId}" belongs to pearl "${checker.manifest.pearl}", not "${pearl.id}"`);
  }
  const selfTest = await verifyChecker(checker);
  if (!selfTest.ok) {
    throw new Error(`probe "${probeId}" failed its negative samples: ${JSON.stringify(selfTest.samples)}`);
  }
  return { checker, selfTest };
}
