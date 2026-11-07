#!/usr/bin/env node
// Register a custom check before it can be evidence.
//
//   check-register <project> --id <id> [--checks-dir <dir>] [--supersede] [--reason <text>]
//   check-register <project> --all [--supersede] [--reason <text>]
//   check-register <project> --unregister <id> [--reason <text>]
//
// The command is the only writer of checks/registry.json. `verify` is read-only.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  listCheckDirs, readCheckId, registerCheck, unregisterCheck,
} from '../src/host/verify/registry.ts';

const USAGE = `usage: check-register <project-dir> (--id <id> | --all | --unregister <id>) [options]

  --id <id>            register the check with this manifest id
  --all                register every check under the checks root
  --unregister <id>    revoke the active registration (history is kept)
  --checks-dir <dir>   checks root (default: <project>/checks)
  --supersede          replace a different registered hash without --unregister
  --reason <text>      recorded in history for unregister/supersede
  --json               print the result as JSON
  -h, --help           show this help

Exit: 0 registered/unchanged/revoked · 1 one or more checks failed · 3 usage`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
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
    console.error(`check-register: ${String(e?.message ?? e)}`);
    console.error(USAGE);
    process.exitCode = 3;
    return;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const projectRoot = positionals[0];
  if (!projectRoot) {
    console.error(USAGE);
    process.exitCode = 3;
    return;
  }

  const checksRoot = values['checks-dir']
    ? resolve(values['checks-dir'])
    : join(resolve(projectRoot), 'checks');
  if (!existsSync(checksRoot)) {
    console.error(`check-register: checks directory not found: ${checksRoot}`);
    process.exitCode = 3;
    return;
  }

  const modes = [values.id ? 'id' : '', values.all ? 'all' : '', values.unregister ? 'unregister' : ''].filter(Boolean);
  if (modes.length !== 1) {
    console.error('check-register: choose exactly one of --id, --all, --unregister');
    console.error(USAGE);
    process.exitCode = 3;
    return;
  }

  const results = [];
  if (values.unregister) {
    results.push(await unregisterCheck(checksRoot, values.unregister, values.reason));
  } else if (values.all) {
    const dirs = await listCheckDirs(checksRoot);
    if (dirs.length === 0) {
      console.error(`check-register: no check directories under ${checksRoot}`);
      process.exitCode = 1;
      return;
    }
    const seen = new Map();
    for (const dir of dirs) {
      const id = await readCheckId(dir);
      if (!id) continue;
      if (seen.has(id)) {
        console.error(`check-register: id "${id}" is declared by more than one directory: ${seen.get(id)}, ${dir}`);
        process.exitCode = 1;
        return;
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
    const matches = [];
    for (const dir of dirs) {
      if (await readCheckId(dir) === values.id) matches.push(dir);
    }
    if (matches.length === 0) {
      console.error(`check-register: no check with id "${values.id}" under ${checksRoot}`);
      process.exitCode = 1;
      return;
    }
    if (matches.length > 1) {
      console.error(`check-register: id "${values.id}" is declared by more than one directory: ${matches.join(', ')}`);
      process.exitCode = 1;
      return;
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

  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

await main();
