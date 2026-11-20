#!/usr/bin/env node
// CI helper: materialize the bundled Python runtime before CadQuery acceptance.
// The runtime is otherwise installed lazily on first use; CI wants the failure
// at this step, not halfway through a compile job.
import { ensurePythonRuntime, pythonRuntimeStatus } from '../src/host/python-runtime.ts';

const status = await pythonRuntimeStatus();
if (status.state === 'ready') {
  console.log(`python runtime already ready at ${status.root}`);
  process.exit(0);
}
if (status.state === 'disabled' || status.state === 'unsupported') {
  console.error(`python runtime is ${status.state}; cannot run CadQuery acceptance`);
  process.exit(1);
}
await ensurePythonRuntime({ onProgress: (message) => console.error(`[python] ${message}`) });
const after = await pythonRuntimeStatus();
if (after.state !== 'ready') {
  console.error(`python runtime did not become ready: ${after.state}`);
  process.exit(1);
}
console.log(`python runtime ready at ${after.root}`);
