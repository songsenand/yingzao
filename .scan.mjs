import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
const root = '/home/songsenand/.dsh/sessions';
const hits = [];
for (const ws of readdirSync(root)) {
  for (const s of readdirSync(join(root, ws))) {
    const f = join(root, ws, s, 'session.v3.jsonl.zstd');
    let raw; try { raw = zlib.zstdDecompressSync(readFileSync(f)).toString('utf8'); } catch { continue; }
    if (!raw.includes('cad-toolbox')) continue;
    const lines = raw.split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]);
    hits.push({ ws, s, cwd: first.cwd, preset: first.agentPreset, lines, mtime: statSync(f).mtime });
  }
}
hits.sort((a,b)=>a.mtime<b.mtime?1:-1);
console.log('sessions mentioning cad-toolbox:', hits.length);
for (const h of hits) {
  console.log(`\n=== ${h.s} ws=${h.ws}\n    cwd=${h.cwd} preset=${h.preset} events=${h.lines.length}`);
  h.lines.forEach((l, i) => {
    if (!l.includes('cad-toolbox')) return;
    const t = JSON.parse(l).type;
    console.log(`    [${i}] ${t}: ${l.slice(0, 300).replace(/\\n/g,' ')}`);
  });
}
