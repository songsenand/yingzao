// dsh-cad-contract — the packaged human/script entry to the sealed contract.
//
// Built to lib/contract-cli.js by esbuild so a clean npm install does not need
// src/. scripts/contract.mjs is the executable wrapper (lib/ first, src/ in a
// development checkout).
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { projectStores } from './project.ts';
import { rebuildContract, verifyContract, writeAssemblyContract } from './assembly-contract.ts';
import { loadAssemblyManifest } from './manifest.ts';

function usage(message?: string): number {
  if (message) console.error(`dsh-cad-contract: ${message}`);
  console.error(`usage:
  dsh-cad-contract verify [--manifest assembly/assembly.json] [--json]
  dsh-cad-contract read [--manifest ...] [--json]
  dsh-cad-contract rebuild [--manifest ...]
  dsh-cad-contract write --reason <text> --expected-revision <n> [--mode merge|replace|create] [--patch <json>] [--root <json>] [--manifest ...] [--dry-run] [--json]
  --patch merges the WHOLE manifest (manufacturing/claims/root); --root merges only the root node.`);
  return 2;
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** The CLI entry. Returns the process exit code (the wrapper exits). */
export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command.startsWith('--')) return usage('missing command');

  const cwd = process.cwd();
  const manifestArg = argValue(argv, '--manifest') ?? 'assembly/assembly.json';
  const manifestPath = isAbsolute(manifestArg) ? manifestArg : join(cwd, manifestArg);
  const asJson = has(argv, '--json');

  try {
    if (command === 'verify') {
      const result = await verifyContract(manifestPath);
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`status: ${result.status}`);
        console.log(`revision: ${result.revision}`);
        console.log(`head: ${result.head ?? '(none)'}`);
        for (const issue of result.issues) console.log(`  - ${issue}`);
      }
      return result.status === 'sealed' || result.status === 'unlocked' ? 0 : 1;
    }

    if (command === 'read' || command === 'export-json') {
      const manifest = await loadAssemblyManifest(manifestPath);
      if (asJson) console.log(JSON.stringify(manifest, null, 2));
      else {
        console.log(`name: ${manifest.name}`);
        console.log(`revision: ${manifest.contractRevision ?? '(unlocked)'}`);
        console.log(`contract: ${manifest.contractHash ?? '(unlocked)'}`);
        console.log(JSON.stringify(manifest, null, 2));
      }
      return 0;
    }

    if (command === 'rebuild') {
      const result = await rebuildContract(manifestPath);
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else console.log(`rebuilt revision ${result.revision} (${result.changeId})`);
      return 0;
    }

    if (command === 'write') {
      const reason = argValue(argv, '--reason');
      if (!reason || !reason.trim()) return usage('write requires a non-empty --reason');
      const mode = argValue(argv, '--mode') ?? 'merge';
      const expectedRevisionRaw = argValue(argv, '--expected-revision');
      const expectedHash = argValue(argv, '--expected-hash');
      if (expectedRevisionRaw === undefined && !expectedHash) return usage('write requires --expected-revision or --expected-hash');
      const patchPath = argValue(argv, '--patch');
      const rootPath = argValue(argv, '--root');
      if (!patchPath && !rootPath) return usage('write requires --patch or --root');
      const root = rootPath ? await readJsonFile(rootPath) as Record<string, unknown> : undefined;
      const patch = patchPath ? await readJsonFile(patchPath) as Record<string, unknown> : undefined;
      const result = await writeAssemblyContract(projectStores(cwd), {
        manifestPath,
        mode: mode as 'create' | 'merge' | 'replace',
        expectedRevision: expectedRevisionRaw === undefined ? undefined : Number(expectedRevisionRaw),
        expectedHash,
        reason,
        ...(root ? { root } : {}),
        ...(patch ? { patch } : {}),
        dryRun: has(argv, '--dry-run'),
        actor: { source: 'dsh-cad-contract' },
      });
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${result.changed ? (result.dryRun ? 'would change' : 'changed') : 'no change'} revision ${result.contractRevision} ${result.changeId || ''}`.trim());
        if (result.diff) console.log(JSON.stringify(result.diff, null, 2));
      }
      return 0;
    }

    return usage(`unknown command "${command}"`);
  } catch (error) {
    console.error(`dsh-cad-contract: ${String((error as Error)?.message ?? error)}`);
    return 1;
  }
}
