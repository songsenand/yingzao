// Preset-aware image-offload executor (plugin-side replacement for the stock
// `@deepseek-ai/dsh-compaction-image-offload`, which cordis.patch.yml disables).
//
// THE RULE (user decision, DESIGN §16–17): standard-mode sessions behave as
// UNMODIFIED dsh; only 营造模式 (cad) sessions get image economy. Concretely:
//
//   * error-waterfall offloads (IMAGE_OFFLOAD_REQUIRED): a cad session never
//     selects user-message TOP-LEVEL images — the reference image that stock
//     behavior always pruned first; every other preset gets EXACTLY the stock
//     selection (oldest-first, no exemption).
//   * the cad session additionally keeps a 24-image retention window enforced
//     proactively from `llm/stream` (options.sessionId → preset); standard
//     mode is never proactively pruned, and NO route-level budget exists —
//     route knobs stay at dsh factory defaults for every preset.
//
// Everything else is byte-for-byte the stock shape: the same `image/offload`
// durable decision event, the same projection validation, the same error
// waterfall semantics (`agent/request-error` → {kind:"retry"};
// `compaction/summary-error` → true).
//
// UPGRADE SAFETY: this lives in our repository, so dsh upgrades cannot clobber
// it. The cost is that it tracks internal seams —
// `sessions.registerMessageProjection`, the `image/offload` event shape, and
// `llm/stream`'s `options.sessionId`. `scripts/accept-image-offload.mjs` pins
// all three; if a dsh upgrade changes them, this acceptance fails loud.

/** The stable failure code the adapters raise when a request exceeds its image budget. */
const IMAGE_OFFLOAD_REQUIRED_CODE = 'IMAGE_OFFLOAD_REQUIRED';

/**
 * The preset a session EFFECTIVELY runs.
 *
 * `session.header.agentPreset` is a creation fact and stays frozen, so a session
 * born 标准模式 and then switched to 营造模式 (allowed while blank) forever reads
 * "standard" in its header. Reading the header therefore disabled the cad image
 * window for exactly the sessions it was written for — microscope5's session
 * switched to cad (228 CAD tool calls prove it) yet the window never fired,
 * because this module asked the header (the §13.14 bug, repeated here; see
 * tools-scope.ts `effectivePresetOf` for the same rule).
 *
 * The live `agentPreset` Session projection is authoritative; the header is only
 * a fallback for profiles that do not compose dsh-agent-presets.
 */
/**
 * OPT-IN override for environments that cannot name the cad preset.
 *
 * The window below is gated on the session's preset. A `dsh --profile headless`
 * evaluation run composes no preset registry at all (`preset-cad` stays pending:
 * "waiting for service: agentPresets"), so `presetOfSession` returns null, the
 * cad window never applies, and a render-heavy session grows without bound until
 * the PROVIDER rejects the request — measured on the bench's 03-microscope level:
 * `INVALID_REQUEST 400: Too many images in request: 70 > 64`, which aborts the
 * segment and voids the round. Setting `DSH_CAD_IMAGE_WINDOW=1` applies the same
 * 24-image window to such a session.
 *
 * Default OFF: standard sessions keep dsh factory behaviour (the user's rule —
 * this plugin patches no route budget).
 */
export function forcedCadImageWindow(): boolean {
  const raw = process.env.DSH_CAD_IMAGE_WINDOW;
  return raw === '1' || raw === 'true' || raw === 'always';
}

function resolvePresetOfSession(session: any, projectionService?: any): string | null {
  try {
    const read = projectionService?.stateOf;
    if (typeof read === 'function') {
      const value = read.call(projectionService, session, 'agentPreset');
      if (typeof value === 'string' && value) return value;
      if (value === null) return null;
    }
  } catch { /* projection unavailable — fall through to the header */ }
  const header = session?.header?.agentPreset;
  return typeof header === 'string' && header ? header : null;
}

/**
 * The preset an image decision should use. Differs from `resolvePresetOfSession`
 * only when `DSH_CAD_IMAGE_WINDOW` is set AND the session names no preset at all
 * — a real `standard` session stays `standard`, so the override cannot widen the
 * window for sessions that deliberately run without 营造模式.
 */
export function presetOfSession(session: any, projectionService?: any): string | null {
  const resolved = resolvePresetOfSession(session, projectionService);
  if (!resolved && forcedCadImageWindow()) return 'cad';
  return resolved;
}

import { DEEPSEEK_KEEP_IMAGES } from './image-budget.ts';
import { recordImageWindow } from './usage.ts';

/**
 * Images a 营造模式 (cad) session keeps in vision — the per-SESSION window
 * enforced here (DESIGN §16.4), mirroring the DeepSeek route's count budget.
 * Standard-mode sessions are NEVER proactively pruned: the only image loss
 * there is the route's pathological-attachment fallback (`PI_AI_KEEP_BYTES`),
 * which ordinary chats never reach. Fairness was the user's explicit call.
 */
export const CAD_IMAGE_WINDOW = DEEPSEEK_KEEP_IMAGES;

/** Retained (not yet offloaded) image occurrences in a request's messages. */
export function countRetainedImages(messages: readonly any[] | undefined): number {
  let count = 0;
  const walk = (blocks: any[]) => {
    for (const b of blocks ?? []) {
      if (b?.type === 'image') { if (b.offloaded !== true) count += 1; }
      else if (b?.type === 'tool-result') walk(b.content);
    }
  };
  for (const m of messages ?? []) walk(m?.content);
  return count;
}

// ── durable decision event: image/offload ───────────────────────────────────

/** Whether a durable value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a durable occurrence index or sequence is canonical. */
function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

export interface OffloadTarget { seq: number; imageIndexes: number[] }

/**
 * Select the oldest retained input-image occurrences to omit.
 *
 * @param protectUserImages - the 造物 exemption: images at the TOP LEVEL of a
 *   `user/message` event are never selected. `false` reproduces the stock
 *   selection exactly (oldest-first, no exemption) for non-cad presets.
 * @param count - additional retained occurrences the adapter needs omitted.
 * @returns targets for an `image/offload` decision, or `null` when nothing
 *   prunable remained (the caller must let the error waterfall proceed).
 */
export function selectOffloadTargets(
  entries: readonly { seq: number; type: string; content: any }[],
  count: number,
  protectUserImages: boolean,
): OffloadTarget[] | null {
  const targets: OffloadTarget[] = [];
  for (const entry of entries) {
    if (count === 0) break;
    if (entry.type !== 'user/message' && entry.type !== 'tool/result') continue;
    const imageIndexes: number[] = [];
    let imageIndex = 0;
    const visit = (blocks: any[]) => {
      for (const block of blocks) {
        if (count === 0) return;
        if (block.type === 'image') {
          const isUserTopLevel = entry.type === 'user/message';
          if (block.offloaded !== true && !(protectUserImages && isUserTopLevel)) {
            imageIndexes.push(imageIndex);
            count -= 1;
          }
          imageIndex += 1;
        }
      }
    };
    visit(entry.content ?? []);
    if (imageIndexes.length > 0) targets.push({ seq: entry.seq, imageIndexes });
  }
  return targets.length > 0 ? targets : null;
}

/** Immutable application of one offload decision to a projected message. */
export function offloadMessageImages(message: any, indexes: readonly number[]): any {
  let imageIndex = 0;
  let selected = 0;
  const visit = (blocks: any[]): any => {
    let next: any[] | undefined;
    for (const [index, block] of blocks.entries()) {
      let projected = block;
      if (block.type === 'image') {
        if (imageIndex === indexes[selected]) {
          if (block.offloaded === true) throw new Error(`image/offload: image index ${imageIndex} is already offloaded`);
          projected = { ...block, offloaded: true };
          selected += 1;
        }
        imageIndex += 1;
      }
      if (projected !== block) next ??= blocks.slice(0, index);
      next?.push(projected);
    }
    return next ?? blocks;
  };
  const content = visit(message.content);
  if (selected !== indexes.length) throw new Error(`image/offload: image index ${indexes[selected]} does not exist`);
  return { ...message, content };
}

/**
 * The durable projection, replayed by live sessions and detached replays.
 * Validation semantics are identical to the stock executor's; the only
 * addition is a guard that a decision never targets a user-message image
 * (defence in depth: the selection function already skips them).
 */
export const imageOffloadProjection = {
  type: 'image/offload',
  project(event: { data: unknown }, context: { nodes: Set<number>; events: any[]; baseSeq: number; messages: Map<number, any> }) {
    const data = event.data as any;
    if (!isRecord(data) || Object.keys(data).length !== 1 || !Array.isArray(data['targets']) || data['targets'].length === 0) {
      throw new Error('image/offload: data must contain a nonempty targets array');
    }
    const messages = new Map<number, any>();
    const nodes = context.nodes;
    for (const target of data['targets']) {
      if (!isRecord(target) || Object.keys(target).length !== 2 || !isIndex(target['seq']) || !Array.isArray(target['imageIndexes']) || target['imageIndexes'].length === 0) {
        throw new Error('image/offload: each target must contain a seq and nonempty imageIndexes');
      }
      const seq = target['seq'];
      if (messages.has(seq)) throw new Error(`image/offload: duplicate target seq ${seq}`);
      if (!nodes.has(seq)) throw new Error(`image/offload: target seq ${seq} is not a current surface node`);
      const source = context.events[seq - context.baseSeq];
      if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
        throw new Error(`image/offload: target seq ${seq} must be user/message or tool/result`);
      }
      let previous = -1;
      for (const index of target['imageIndexes']) {
        if (!isIndex(index) || index <= previous) throw new Error('image/offload: imageIndexes must be strictly increasing non-negative safe integers');
        previous = index;
      }
      const message = context.messages.get(seq) ?? (source.type === 'user/message' ? source.data : source.data.message);
      messages.set(seq, offloadMessageImages(message, target['imageIndexes']));
    }
    return messages;
  },
};

/**
 * Record one offload decision on the session and report whether any prunable
 * occurrence remained. Dispatches by the session's preset: cad (营造模式)
 * protects user-message top-level images; every other preset gets EXACTLY the
 * stock selection (oldest-first, no exemption) — standard mode behaves as
 * unmodified dsh. `true` means a decision was appended and the request should
 * retry.
 */
export function offloadOldestProtected(
  session: any,
  sourceEventSeqs: readonly number[],
  count: number,
  projectionService?: any,
): boolean {
  const targets = planOffloadTargets(session, sourceEventSeqs, count, projectionService);
  if (!targets) return false;
  session.append('image/offload', { targets });
  return true;
}

/** Plan (without appending) the protected offload for a session's occurrences. */
export function planOffloadTargets(
  session: any,
  sourceEventSeqs: readonly number[],
  count: number,
  projectionService?: any,
): OffloadTarget[] | null {
  const cad = presetOfSession(session, projectionService) === 'cad';
  const entries = [];
  for (const seq of sourceEventSeqs) {
    const event = session.eventAt(seq);
    if (!event || (event.type !== 'user/message' && event.type !== 'tool/result')) continue;
    entries.push({ seq, type: event.type, content: session.deriveEventMessage(event).content });
  }
  return selectOffloadTargets(entries, count, cad);
}

/**
 * Mount the executor: the projection plus the two error-waterfall listeners.
 *
 * The `sessions` service may activate after this plugin, so the projection
 * registration polls for it (headless profiles never have one — there, image
 * offload simply never fires because nothing serves image routes).
 */
export function applyProtectedImageOffload(ctx: any): void {
  let mounted = false;
  const tryMount = (attempt = 0): void => {
    if (mounted) return;
    const sessions = ctx.reflect.get('sessions');
    if (!sessions || typeof sessions.registerMessageProjection !== 'function') {
      if (attempt < 60) setTimeout(() => tryMount(attempt + 1), 2_000);
      else ctx.logger?.warn?.('cad-harness: image-offload executor never found the sessions service — user images are unprotected');
      return;
    }
    mounted = true;
    sessions.registerMessageProjection(imageOffloadProjection);
    ctx.logger?.info?.('cad-harness: preset-aware image-offload executor mounted (cad: user images exempt + 24-image window; other presets: stock behavior)');
  };
  tryMount();

  // Agent request waterfall: identical semantics to the stock executor.
  ctx.on('agent/request-error', ({ agent, failure }: any, next: () => unknown) => {
    if (failure?.code !== IMAGE_OFFLOAD_REQUIRED_CODE || failure?.offloadImages === undefined) return next();
    if (!offloadOldestProtected(agent.session, agent.session.surface.nodes, failure.offloadImages,
      ctx.reflect.get('sessionProjections'))) return next();
    return Promise.resolve({ kind: 'retry' });
  });

  // Compaction summary waterfall: same, keyed off the LlmError the summary
  // request raised. Duck-typed on `code` so this module needs no dsh-llm import.
  ctx.on('compaction/summary-error', ({ session, sourceEventSeqs, error, signal }: any, next: () => unknown) => {
    if ((error as any)?.code !== IMAGE_OFFLOAD_REQUIRED_CODE || (error as any)?.failure?.offloadImages === undefined) return next();
    signal?.throwIfAborted();
    if (!offloadOldestProtected(session, sourceEventSeqs, error.failure.offloadImages,
      ctx.reflect.get('sessionProjections'))) return next();
    return true;
  });

  // Per-preset image window (DESIGN §16.4): every request carries its
  // sessionId; a 营造模式 session over the window gets a proactive offload
  // decision so the NEXT request fits. Standard-mode sessions are exempt —
  // that is the whole point of doing this here instead of in the route config.
  //
  // Every observation is recorded to the image-window telemetry (§23.5),
  // including the reasons it did NOT apply, so "did the window run?" is a data
  // question rather than an archaeology exercise.
  const windowInFlight = new Set<string>();
  ctx.on('llm/stream', (options: any, next: () => unknown) => {
    const sessionId: string | undefined = options?.sessionId;
    if (!sessionId) {
      recordImageWindow({ ts: new Date().toISOString(), outcome: 'no-session', preset: null });
      return next();
    }
    if (options?.purpose) {
      // Auxiliary calls (session-title, compaction) neither carry the
      // conversation's image load nor should drive the window.
      recordImageWindow({ ts: new Date().toISOString(), sessionId, outcome: 'aux-purpose', preset: null, note: String(options.purpose) });
      return next();
    }
    if (windowInFlight.has(sessionId)) {
      recordImageWindow({ ts: new Date().toISOString(), sessionId, outcome: 'in-flight', preset: null });
      return next();
    }
    windowInFlight.add(sessionId);
    void Promise.resolve()
      .then(() => {
        const sessions = sessionsRef(ctx);
        const decision = decideSessionWindow(
          sessions, options,
          (session) => presetOfSession(session, ctx.reflect.get('sessionProjections')),
        );
        // Apply here (not through the compatibility wrapper) so the telemetry
        // records the DECISION — the wrapper's `null` cannot tell
        // preset-not-cad from no-service, which is precisely the question the
        // microscope5 post-mortem could not answer.
        if (decision.outcome === 'over-window' && decision.plan) {
          sessions.get(options.sessionId).append('image/offload', { targets: decision.plan });
        }
        recordImageWindow({
          ts: new Date().toISOString(), sessionId,
          outcome: decision.outcome === 'over-window' ? 'applied' : decision.outcome,
          preset: decision.preset,
          retained: decision.retained,
          excess: decision.excess,
          window: CAD_IMAGE_WINDOW,
          ...(decision.targets ? { pruned: decision.targets.reduce((a, t) => a + t.images, 0), targets: decision.targets } : {}),
        });
      })
      .catch((e) => {
        recordImageWindow({
          ts: new Date().toISOString(), sessionId, outcome: 'error', preset: null,
          note: String((e as Error)?.message ?? e),
        });
        ctx.logger?.warn?.(`cad-harness: image window check failed: ${String((e as Error)?.message ?? e)}`);
      })
      .finally(() => windowInFlight.delete(sessionId));
    return next();
  });
}

/** The sessions service reference, resolved lazily (mount may still be polling). */
function sessionsRef(ctx: any): any {
  return ctx.reflect.get('sessions');
}

/** What the window would do for one observed request (no side effects). */
export interface WindowDecision {
  outcome: 'over-window' | 'under-window' | 'preset-not-cad' | 'no-session' | 'no-service';
  preset: string | null;
  retained: number;
  excess: number;
  /** Telemetry shape: how many occurrences per message. */
  targets?: { seq: number; images: number }[];
  /** Executor shape: the exact occurrences to mark offloaded. */
  plan?: OffloadTarget[];
}

/**
 * Decide (but do not apply) the per-preset window for one request.
 *
 * Split from the executor so the decision is observable in telemetry and
 * testable without a session that can be mutated.
 */
export function decideSessionWindow(
  sessions: any,
  options: { sessionId?: string; messages?: any[] },
  readPreset: (session: any) => string | null = (s) => presetOfSession(s),
): WindowDecision {
  const sessionId = options?.sessionId;
  if (!sessionId) return { outcome: 'no-session', preset: null, retained: 0, excess: 0 };
  if (typeof sessions?.get !== 'function') return { outcome: 'no-service', preset: null, retained: 0, excess: 0 };
  const session = sessions.get(sessionId);
  if (!session) return { outcome: 'no-session', preset: null, retained: 0, excess: 0 };
  // The EFFECTIVE preset (live projection, header fallback) — never the header
  // alone: a blank session may have switched to 营造模式 after creation.
  const preset = readPreset(session);
  const retained = countRetainedImages(options?.messages);
  const excess = retained - CAD_IMAGE_WINDOW;
  if (preset !== 'cad') return { outcome: 'preset-not-cad', preset, retained, excess };
  if (excess <= 0) return { outcome: 'under-window', preset, retained, excess };
  const plan = planOffloadTargets(session, session.surface?.nodes ?? [], excess) ?? undefined;
  const targets = plan?.map((t) => ({ seq: t.seq, images: t.imageIndexes.length }));
  return { outcome: 'over-window', preset, retained, excess, ...(targets ? { targets, plan } : {}) };
}

/**
 * Apply-or-report the window for one request. Returns the decision with
 * `appended`, or `null` when the window does not apply (compatibility shape for
 * callers/tests that only care about the cad case).
 */
export function enforceSessionWindow(
  sessions: any,
  options: { sessionId?: string; messages?: any[] },
  readPreset: (session: any) => string | null = (s) => presetOfSession(s),
): { preset: string | null; retained: number; excess: number; appended: boolean; targets?: { seq: number; images: number }[] } | null {
  const decision = decideSessionWindow(sessions, options, readPreset);
  if (decision.outcome === 'preset-not-cad' || decision.outcome === 'no-session' || decision.outcome === 'no-service') return null;
  if (decision.outcome === 'under-window') {
    return { preset: decision.preset, retained: decision.retained, excess: decision.excess, appended: false };
  }
  if (!decision.plan) return { preset: decision.preset, retained: decision.retained, excess: decision.excess, appended: false };
  sessions.get(options.sessionId).append('image/offload', { targets: decision.plan });
  return {
    preset: decision.preset, retained: decision.retained, excess: decision.excess,
    appended: true, targets: decision.targets,
  };
}
