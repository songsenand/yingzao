#!/usr/bin/env node
// Host boot guard: DSH's exact Fetch-route registry is a Map keyed by PATH, and
// registerFetchRoute() throws when that path is already present — even when the
// second registration only adds a disjoint method. The CAD host registers its
// browser routes from a retry timer (connection may activate after the plugin),
// so that throw is an uncaught exception that kills the whole dsh process
// (2026-11-27: POST and GET /api/cad/fluid/job were two registrations and the
// profile would not boot). This check asserts the invariant the shipped bundle
// has to satisfy:
//   one registration per path, and every registration declares its methods.
//
// Usage: node scripts/accept-fetch-routes.mjs [file...]
// (No arguments checks the source and the built bundle.)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FILES = process.argv.length > 2 ? process.argv.slice(2) : ['src/host/tools.ts', 'lib/index.js'];

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Index just past a string/comment/regex-ish run starting at `i`, or `i`. */
function skipNonCode(text, i) {
  const c = text[i];
  if (c === '/' && text[i + 1] === '/') {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl + 1;
  }
  if (c === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue; }
      // A `${...}` inside a template literal is code again; its braces must be
      // stepped over as a unit so they cannot unbalance the enclosing literal.
      if (c === '`' && text[j] === '$' && text[j + 1] === '{') {
        const close = matchBrace(text, j + 1);
        j = close === -1 ? text.length : close + 1;
        continue;
      }
      if (text[j] === c) return j + 1;
      j++;
    }
    return text.length;
  }
  return i;
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length;) {
    const skipped = skipNonCode(text, i);
    if (skipped !== i) { i = skipped; continue; }
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
    i++;
  }
  return -1;
}

/** Split an object body on its depth-0 commas, preserving string contents. */
function splitTopLevel(body) {
  let depth = 0;
  let start = 0;
  const chunks = [];
  for (let i = 0; i < body.length;) {
    const skipped = skipNonCode(body, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = body[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) { chunks.push(body.slice(start, i)); start = i + 1; }
    i++;
  }
  chunks.push(body.slice(start));
  return chunks;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function parseRoutes(text, label) {
  const routes = [];
  const needle = 'connection.fetch.register(';
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    const open = text.indexOf('{', at + needle.length);
    if (open === -1) continue;
    const close = matchBrace(text, open);
    if (close === -1) continue;
    const body = text.slice(open + 1, close);
    let path;
    let pathDynamic = false;
    let methods;
    let methodsDynamic = false;
    for (const chunk of splitTopLevel(body)) {
      const pathLiteral = /^\s*path\s*:\s*(['"])(.*?)\1\s*$/s.exec(chunk);
      if (pathLiteral) { path = pathLiteral[2]; continue; }
      if (/^\s*path\s*:/.test(chunk)) { pathDynamic = true; continue; }
      const methodsLiteral = /^\s*methods\s*:\s*\[([^\]]*)\]\s*$/s.exec(chunk);
      if (methodsLiteral) {
        methods = [...methodsLiteral[1].matchAll(/(['"])(.*?)\1/g)].map((m) => m[2]);
        continue;
      }
      if (/^\s*methods\s*:/.test(chunk)) methodsDynamic = true;
    }
    routes.push({ path, pathDynamic, methods, methodsDynamic, line: lineOf(text, at), label });
  }
  return routes;
}

const files = FILES.map((rel) => ({ rel, absolute: resolve(ROOT, rel), text: (() => {
  try { return readFileSync(resolve(ROOT, rel), 'utf8'); } catch { return null; }
})() }));

for (const file of files) {
  if (file.text === null) {
    console.log(`  SKIP ${file.rel} (not present)`);
    continue;
  }
  const routes = parseRoutes(file.text, file.rel);
  check(`${file.rel}: parsed ${routes.length} fetch registrations`, routes.length > 0);

  const missingMethods = routes.filter((route) => !route.methodsDynamic && (route.methods === undefined || route.methods.length === 0));
  check(
    `${file.rel}: every registration declares methods`,
    missingMethods.length === 0,
    missingMethods.map((route) => `line ${route.line}`).join(', '),
  );

  const repeatedMethod = routes.filter((route) => route.methods && new Set(route.methods).size !== route.methods.length);
  check(
    `${file.rel}: no registration repeats a method`,
    repeatedMethod.length === 0,
    repeatedMethod.map((route) => `line ${route.line}`).join(', '),
  );

  // The boot-fatal invariant: DSH keys routes by path, so a second registration
  // for the same path throws even when the method sets are disjoint.
  const byPath = new Map();
  for (const route of routes) {
    if (route.path === undefined || route.pathDynamic) continue;
    const seen = byPath.get(route.path) ?? [];
    seen.push(route);
    byPath.set(route.path, seen);
  }
  const duplicates = [...byPath].filter(([, seen]) => seen.length > 1);
  check(
    `${file.rel}: no path registered twice`,
    duplicates.length === 0,
    duplicates
      .map(([path, seen]) => `${path} ×${seen.length} (${seen.map((r) => `line ${r.line} [${(r.methods ?? ['?']).join(',')}]`).join(', ')})`)
      .join('; '),
  );

  const dynamic = routes.filter((route) => route.pathDynamic).length;
  if (dynamic > 0) console.log(`  NOTE ${file.rel}: ${dynamic} registration(s) take the path from a variable (checked structurally, not for uniqueness)`);
}

console.log(`\naccept-fetch-routes: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
