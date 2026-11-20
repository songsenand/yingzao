#!/usr/bin/env node
// L1.10: the kernel reaches the prompt, not just cad_session info. This drives
// the real registration function with a fake agent/prompt service: it must
// install for CAD sessions (and no-preset/headless sessions), skip other
// presets, follow preset switches, and read project marker over global config.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const home = await mkdtemp(join(tmpdir(), 'kernel-context-home-'));
const workspace = await mkdtemp(join(tmpdir(), 'kernel-context-work-'));
process.env.DSH_HOME = home;

try {
  await mkdir(join(workspace, 'cad-data'), { recursive: true });
  await writeFile(join(workspace, 'cad-data', 'project.json'), JSON.stringify({ schemaVersion: 1, key: 'ctx', defaultKernel: 'cadquery' }));
  await mkdir(join(home, 'cad'), { recursive: true });
  await writeFile(join(home, 'cad', 'backend.json'), JSON.stringify({ kernel: 'openscad', compileBackend: 'auto', binaryPath: null }));

  const { registerKernelPrompt, effectiveKernelForSession, kernelPromptText } = await import('../src/host/kernel-context.ts');
  const registrations = [];
  const disposed = [];
  const handlers = new Map();
  const fakeCtx = {
    logger: { info: () => {}, warn: () => {} },
    on: (event, fn) => { handlers.set(event, fn); },
  };
  const makeAgent = (id, preset) => {
    const defs = [];
    let agent;
    agent = {
      currentPreset: preset,
      session: { header: { id, cwd: workspace, agentPreset: preset } },
      ctx: {
        sessionProjections: { stateOf: () => agent.currentPreset ?? preset },
        systemPrompt: {
          context: (def) => {
            defs.push(def);
            registrations.push({ id, def });
            return () => { disposed.push({ id, name: def.name }); };
          },
        },
      },
    };
    agent.defs = defs;
    return agent;
  };

  registerKernelPrompt(fakeCtx, { toolScope: 'preset', presets: ['cad'] });
  const cad = makeAgent('s-cad', 'cad');
  handlers.get('agent/created')({ agent: cad });
  check(cad.defs.length === 1 && cad.defs[0].name === 'cad-kernel', 'CAD session gets one kernel context', JSON.stringify(cad.defs.map((d) => d.name)));
  check(cad.defs[0]?.required === true, 'kernel context is required (not suppressible)');
  const text = cad.defs[0]?.text();
  check(typeof text === 'string' && text.includes('cadquery') && text.includes('generate_part({code})'), 'project marker wins and names the CQ call', text);
  check(text.includes('Do not use scadCode') && !text.includes('generate_part({scadCode'), 'CQ text forbids scadCode rather than recommending it', text);
  check(!text.includes('BOSL2'), 'CQ text does not mention BOSL2 at all', text);
  const scadText = kernelPromptText({ kernel: 'openscad', source: 'global', root: workspace });
  check(scadText.includes('BOSL2 (OpenSCAD-only, installed separately)'), 'SCAD text names BOSL2 as OpenSCAD-only and separately installed', scadText);
  check(effectiveKernelForSession('s-cad', workspace).source === 'project', 'effective kernel reports the project source');

  const standard = makeAgent('s-standard', 'standard');
  handlers.get('agent/created')({ agent: standard });
  check(standard.defs.length === 0, 'non-CAD preset pays no kernel context', JSON.stringify(standard.defs));

  const headless = makeAgent('s-headless', null);
  handlers.get('agent/created')({ agent: headless });
  check(headless.defs.length === 1, 'no-preset/headless session still gets the kernel context');

  cad.currentPreset = 'standard';
  handlers.get('agent-preset/selected')('s-cad', 'standard');
  check(disposed.some((d) => d.id === 's-cad' && d.name === 'cad-kernel'), 'switching away disposes the context', JSON.stringify(disposed));
  cad.currentPreset = 'cad';
  handlers.get('agent-preset/selected')('s-cad', 'cad');
  check(cad.defs.length === 2 && cad.defs.at(-1)?.name === 'cad-kernel', 'switching back re-installs the context', String(cad.defs.length));

  const noPrompt = { logger: { info: () => {}, warn: () => {} }, on: (event, fn) => handlers.set(`np:${event}`, fn) };
  registerKernelPrompt(noPrompt, { presets: ['cad'] });
  let threw = false;
  try {
    const plain = makeAgent('s-noprompt', 'cad');
    delete plain.ctx.systemPrompt;
    noPromptHandlers(noPrompt, plain);
  } catch { threw = true; }
  function noPromptHandlers(_ctx, agent) {
    const fn = handlers.get('np:agent/created') ?? handlers.get('agent/created');
    fn({ agent });
  }
  check(!threw, 'a host without systemPrompt does not break session creation');
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK');
process.exit(failures ? 1 : 0);
