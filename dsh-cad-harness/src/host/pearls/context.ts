// Build the executable context a template step binds against.
// It only reads project artifacts; it never executes a tool.

import { join } from 'node:path';
import { loadProjectProfile } from './profile.ts';
import { loadAssemblyManifest, flattenParts } from '../manifest.ts';
import type { StepContext } from './inputs.ts';

export async function buildStepContext(projectRoot: string, input: Record<string, unknown> = {}): Promise<StepContext> {
  const profile = await loadProjectProfile(projectRoot);
  const assemblyPath = join(projectRoot, 'assembly/assembly.json');
  const manifest = await loadAssemblyManifest(assemblyPath);
  const parts = flattenParts(manifest.root)
    .filter((p) => p.node.kind === 'part' && p.node.version)
    .map((p) => ({
      name: p.id,
      versionId: p.node.version,
      ...(p.transform?.translate ? { translate: p.transform.translate } : {}),
      ...(p.transform?.rotate ? { rotate: p.transform.rotate } : {}),
    }));
  return {
    project: {
      profile: profile.manifest,
      rulePack: profile.rulePack.manifest,
      assembly: { path: assemblyPath, manifest, parts },
    },
    input,
  };
}
