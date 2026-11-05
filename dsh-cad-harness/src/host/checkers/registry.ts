// Checker registry: load, hash and self-test a checker directory.
//
// A checker is registered by manifest + files. Loading it does NOT execute it; mounting
// does. `verifyChecker` runs the declared negative samples, because a checker that
// passes a known-bad fixture is untrusted no matter how good its manifest looks.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertCheckerManifest } from './protocol.ts';
import { runChecker, runNegativeSample } from './runner.ts';
import type { CheckerInput, CheckerManifest, CheckerReport, RunCheckerResult } from './types.ts';

export interface LoadedChecker {
  manifest: CheckerManifest;
  dir: string;
  /** Hash of manifest + manifest entry files; pin this in pearl templates. */
  hash: string;
}

export interface CheckerSelfTest {
  checker: string;
  ok: boolean;
  hash: string;
  samples: { fixture: string; ok: boolean; status: string; detail: string }[];
}

async function hashFiles(dir: string, files: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const rel of files) {
    const p = resolve(dir, rel);
    try {
      hash.update(rel);
      hash.update(await readFile(p));
    } catch {
      hash.update(`${rel}:missing`);
    }
  }
  return hash.digest('hex');
}

/** Load and validate a checker directory. Throws on an invalid manifest. */
export async function loadChecker(dir: string): Promise<LoadedChecker> {
  const manifestPath = join(dir, 'manifest.json');
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  assertCheckerManifest(raw);
  const manifest = raw as CheckerManifest;
  const entryFiles = manifest.entry
    .map((x, i) => (i === 0 ? '' : x))
    .filter((x) => x && !x.startsWith('-'));
  return { manifest, dir: resolve(dir), hash: await hashFiles(dir, ['manifest.json', ...entryFiles]) };
}

/** Run one fixture through a loaded checker. */
export async function runFixture(
  checker: LoadedChecker,
  input: CheckerInput,
): Promise<RunCheckerResult> {
  return runChecker(checker.manifest, input, { cwd: checker.dir });
}

/** Run every declared negative sample. Missing fixtures fail closed. */
export async function verifyChecker(checker: LoadedChecker): Promise<CheckerSelfTest> {
  const samples: CheckerSelfTest['samples'] = [];
  for (const rel of checker.manifest.negativeSamples ?? []) {
    const fixture = resolve(checker.dir, rel);
    try {
      await stat(fixture);
    } catch {
      samples.push({ fixture: rel, ok: false, status: 'missing', detail: 'fixture file not found' });
      continue;
    }
    const result = await runNegativeSample(checker.manifest, checker.dir, fixture);
    samples.push({
      fixture: rel,
      ok: result.ok,
      status: result.report.status,
      detail: result.detail,
    });
  }
  return {
    checker: `${checker.manifest.id}@${checker.manifest.version}`,
    ok: samples.length > 0 && samples.every((s) => s.ok),
    hash: checker.hash,
    samples,
  };
}

/** Run a checker against a fixture and return only the report (for accept scripts). */
export async function runFixtureReport(checkerDir: string, fixturePath: string): Promise<CheckerReport> {
  const checker = await loadChecker(checkerDir);
  const input = JSON.parse(await readFile(fixturePath, 'utf8')) as CheckerInput;
  const { report } = await runFixture(checker, input);
  return report;
}
