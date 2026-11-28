// Packaged custom-check CLI: the same registration desk as before, but bundled
// into lib/check-register.js so a clean npm install does not need src/ or tsx.
//
// The command is the only writer of checks/registry.json. `verify` is read-only.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  listCheckDirs, readCheckId, registerCheck, unregisterCheck,
} from './registry.ts';
import type { RegisterResult } from './registry.ts';

export const USAGE = `usage: check-register <project-dir> (--id <id> | --all | --unregister <id>) [options]

  --id <id>            register the check with this manifest id
  --all                register every check under the checks root
  --unregister <id>    revoke the active registration (history is kept)
  --checks-dir <dir>   checks root (default: <project>/checks)
  --supersede          replace a different registered hash without --unregister
  --reason <text>      recorded in history for unregister/supersede
  --json               print the result as JSON
  -h, --help           show this help

Exit: 0 registered/unchanged/revoked · 1 one or more checks failed · 3 usage`;

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv as string[],
      allowPositionals: true,
      options: {
        id: { type: 'string' },
        all: { type: 'boolean' },
        unregister: { type: 'string' },
        'checks-dir': { type: 'string' },
        supersede: { type: 'boolean' },
        reason: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    console.error(`check-register: ${String((e as Error)?.message ?? e)}`);
    console.error(USAGE);
    return 3;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const projectRoot = positionals[0];
  if (!projectRoot) {
    console.error(USAGE);
    return 3;
  }

  const checksRoot = values['checks-dir']
    ? resolve(values['checks-dir'])
    : join(resolve(projectRoot), 'checks');
  if (!existsSync(checksRoot)) {
    console.error(`check-register: checks directory not found: ${checksRoot}`);
    return 3;
  }

  const modes = [values.id ? 'id' : '', values.all ? 'all' : '', values.unregister ? 'unregister' : ''].filter(Boolean);
  if (modes.length !== 1) {
    console.error('check-register: choose exactly one of --id, --all, --unregister');
    console.error(USAGE);
    return 3;
  }

  const results: RegisterResult[] = [];
  if (values.unregister) {
    results.push(await unregisterCheck(checksRoot, values.unregister, values.reason));
  } else if (values.all) {
    const dirs = await listCheckDirs(checksRoot);
    if (dirs.length === 0) {
      console.error(`check-register: no check directories under ${checksRoot}`);
      return 1;
    }
    const seen = new Map<string, string>();
    for (const dir of dirs) {
      const id = await readCheckId(dir);
      if (!id) continue;
      if (seen.has(id)) {
        console.error(`check-register: id "${id}" is declared by more than one directory: ${seen.get(id)}, ${dir}`);
        return 1;
      }
      seen.set(id, dir);
    }
    for (const dir of dirs) {
      results.push(await registerCheck(checksRoot, dir, {
        ...(values.supersede ? { supersede: true } : {}),
        ...(values.reason ? { reason: values.reason } : {}),
      }));
    }
  } else {
    const dirs = await listCheckDirs(checksRoot);
    const matches: string[] = [];
    for (const dir of dirs) {
      if (await readCheckId(dir) === values.id) matches.push(dir);
    }
    if (matches.length === 0) {
      console.error(`check-register: no check with id "${values.id}" under ${checksRoot}`);
      return 1;
    }
    if (matches.length > 1) {
      console.error(`check-register: id "${values.id}" is declared by more than one directory: ${matches.join(', ')}`);
      return 1;
    }
    results.push(await registerCheck(checksRoot, matches[0], {
      ...(values.supersede ? { supersede: true } : {}),
      ...(values.reason ? { reason: values.reason } : {}),
    }));
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      if (result.ok) {
        console.log(`${result.status}  ${result.id}@${result.version}  ${result.hash}  registeredAt=${result.registeredAt}`);
      } else {
        console.error(`ERROR  ${result.id ?? ''}  ${result.errors.join('; ')}`);
      }
    }
  }

  return results.every((r) => r.ok) ? 0 : 1;
}
