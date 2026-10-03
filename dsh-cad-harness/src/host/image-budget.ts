// Image-context pruning: the policy numbers, and the half of it that cannot be
// declared in `cordis.patch.yml`.
//
// Why images need pruning at all: the agent loop re-sends the whole session
// history on every step, and every `generate_part` result carries its own
// render views. Measured on this workspace's telemetry (1094 conversation
// calls): image occurrences per request reach 88 — ~88k image tokens in one
// request, against ~168k text tokens. Images were a quarter of the peak
// request and a quarter of all tokens ever sent.
//
// The pruning itself is the harness's own, already-tested code:
// `offloadRequestImagesWithPolicy()` replaces the OLDEST image occurrences, in
// whole count/byte quanta, with `offloadedImageText(ref, access)` — a stable
// placeholder that names the attachment AND its local normalized path, so the
// model can pull a pruned image back with `read_image` whenever it actually
// needs it. Nothing is destroyed; only the request projection changes, and the
// token meter prices an offloaded image at zero visual tokens, so compaction
// pressure accounting agrees with what the provider receives.
//
// Two routes, two mechanisms:
//   * DeepSeek — a global count budget, declared as a config patch on the
//     `llm-deepseek` row (see cordis.patch.yml).
//   * pi-ai (GLM, ...) — only a per-PROVIDER byte budget exists, and provider
//     profile names come from the user's settings document, so a static patch
//     cannot address them and creating one would register a phantom route.
//     Applied at boot through the merge-only settings API instead.

/** Occurrences the DeepSeek route keeps; mirrors `maxImagesPerRequest`. */
export const DEEPSEEK_KEEP_IMAGES = 24;
/** Removal step; mirrors `imageOffloadCountQuantum` (2 render rounds of 4 views). */
export const DEEPSEEK_COUNT_QUANTUM = 8;
/**
 * Bytes the pi-ai routes keep — a FALLBACK for pathological attachments only.
 *
 * Since DESGIGN §16.4 the per-preset image window is enforced at the SESSION
 * level by the protected offload executor (`image-offload.ts`: 造物模式 keeps
 * 24 images, standard mode is never proactively pruned). The route knob cannot
 * see presets, so it must not be where fairness is decided — it only has to
 * stop one pathological attachment from exploding a request. 8 MiB of base64
 * ≈ a dozen full-size normalized screenshots; ordinary chats never touch it,
 * and a CAD render storm (88 × 45KB ≈ 4 MB) also fits, because the session
 * window prunes it a request earlier.
 *
 * (History: 2.5 MiB — measured carrying 296 microscope renders, the §14
 * failure; then 256 KiB as a fairness-blind global cap, rejected by the user
 * as unfair to standard mode.)
 */
export const PI_AI_KEEP_BYTES = 8 * 1024 * 1024;

/**
 * How many leading image occurrences a request projection removes.
 *
 * A local mirror of `offloadedImagePrefixCount()` from `@deepseek-ai/dsh-llm`,
 * which this plugin cannot import (that package is a sibling bundle, not one of
 * our dependencies). Used ONLY for telemetry: the real removal always happens
 * inside the adapter. `scripts/accept-image-budget.mjs` checks this mirror
 * against the real function over a matrix of counts and quanta, so the reported
 * numbers cannot silently drift from what the provider receives.
 *
 * @param lengths - represented byte length of every occurrence, in request
 *   order. "Represented" matters: the DeepSeek route accounts raw attachment
 *   bytes, the pi-ai route accounts base64 length. Convert before calling.
 * @param maxImages - count budget; `undefined` leaves it unbounded.
 * @param maxBytes - byte budget; `undefined` leaves it unbounded.
 * @param countQuantum - excess count removed as one step.
 * @param byteQuantum - excess bytes removed as one step.
 * @returns how many leading occurrences the projection replaces.
 */
export function offloadedPrefixCount(
  lengths: readonly number[],
  maxImages: number | undefined,
  maxBytes: number | undefined,
  countQuantum = 1,
  byteQuantum = 1,
): number {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0);
  const excessCount = maxImages === undefined ? 0 : Math.max(0, lengths.length - maxImages);
  const excessBytes = maxBytes === undefined ? 0 : Math.max(0, total - maxBytes);
  if (excessCount === 0 && excessBytes === 0) return 0;
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum;
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum;
  let count = 0;
  let removedBytes = 0;
  for (const imageBytes of lengths) {
    const done = count >= removeCount
      && (removeBytes === 0 || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes));
    if (done) break;
    removedBytes += imageBytes;
    count += 1;
  }
  return count;
}

/**
 * Give every configured pi-ai provider profile an image budget, so its route
 * prunes old images the way the DeepSeek route does.
 *
 * Merge-only and tighten-only, by construction:
 *   * `settings.mutate` writes exactly one path per provider and the harness
 *     validates the resolved candidate before persisting — a refusal changes
 *     nothing;
 *   * a profile that already sets a budget at or below ours is left alone, so a
 *     deliberate user value always wins and repeated boots are no-ops;
 *   * provider names come from the resolved section, so a profile that defines
 *     none is never invented (a static base entry would register a phantom
 *     route and could fail the section's own serviceability check).
 *
 * Runs once the `settings` service exists and again whenever the `llm-pi-ai`
 * namespace commits, which covers a provider profile added later. Failures are
 * logged and contained: pruning is an optimization, never a boot dependency.
 *
 * @param ctx - host plugin context.
 */
export function applyPiAiImageBudget(ctx: any): void {
  try {
    ctx.inject(['settings'], (sctx: any) => {
      const run = () => { void applyOnce(sctx); };
      run();
      // Our own write commits the namespace, which re-enters here; the
      // tighten-only guard makes that second pass a no-op rather than a loop.
      sctx.on('settings/updated', (ns: string) => { if (ns === 'llm-pi-ai') run(); });
    });
  } catch (e) {
    ctx.logger?.warn?.(`cad-harness: image budget not applied: ${String((e as Error)?.message ?? e)}`);
  }
}

/** One idempotent pass over the resolved `llm-pi-ai` section. */
async function applyOnce(sctx: any): Promise<void> {
  try {
    const settings = sctx?.settings;
    if (typeof settings?.get !== 'function' || typeof settings?.mutate !== 'function') return;
    const section = settings.get('llm-pi-ai') as { providers?: Record<string, unknown> } | undefined;
    const providers = section?.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return;

    const ops: { op: 'set'; path: string[]; value: number }[] = [];
    const names: string[] = [];
    for (const [name, profile] of Object.entries(providers)) {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
      const cur = profile as { maxRequestImageBytes?: unknown };
      // Tighten-only: an existing value at or below ours wins (a deliberate
      // user setting, or our own earlier pass). The adapter's schema has no
      // count knob, so maxRequestImageBytes is the one and only key we write —
      // anything else we might invent would be silently dropped (or worse,
      // fail schema validation) by the installed dsh-llm-pi-ai.
      if (typeof cur.maxRequestImageBytes === 'number' && cur.maxRequestImageBytes <= PI_AI_KEEP_BYTES) continue;
      ops.push({ op: 'set', path: ['providers', name, 'maxRequestImageBytes'], value: PI_AI_KEEP_BYTES });
      names.push(name);
    }
    if (ops.length === 0) return;

    await settings.mutate('llm-pi-ai', ops);
    sctx.logger?.info?.(
      `cad-harness: llm-pi-ai image budget → maxRequestImageBytes=${PI_AI_KEEP_BYTES} (${names.join(', ')})`,
    );
  } catch (e) {
    try {
      sctx?.logger?.warn?.(`cad-harness: llm-pi-ai image budget not applied: ${String((e as Error)?.message ?? e)}`);
    } catch { /* logging must never throw */ }
  }
}
