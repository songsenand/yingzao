// Preset-aware image-offload executor (plugin-side replacement for the stock
// `@deepseek-ai/dsh-compaction-image-offload`, which cordis.patch.yml disables).
//
// THE RULE (user decision, DESGIGN §16–17): standard-mode sessions behave as
// UNMODIFIED dsh; only 造物模式 (cad) sessions get image economy. Concretely:
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

import { DEEPSEEK_KEEP_IMAGES } from './image-budget.ts';

/**
 * Images a 造物模式 (cad) session keeps in vision — the per-SESSION window
 * enforced here (DESGIGN §16.4), mirroring the DeepSeek route's count budget.
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

/** Whether a projected message's blocks contain an image at top level. */
// (kept for future diagnostics; the projection itself no longer refuses
// user-image targets — non-cad presets must replay stock decisions verbatim)
function hasTopLevelImage(content: any): boolean {
  return Array.isArray(content) && content.some((b) => b?.type === 'image');
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
 * occurrence remained. Dispatches by the session's preset: cad (造物模式)
 * protects user-message top-level images; every other preset gets EXACTLY the
 * stock selection (oldest-first, no exemption) — standard mode behaves as
 * unmodified dsh. `true` means a decision was appended and the request should
 * retry.
 */
export function offloadOldestProtected(session: any, sourceEventSeqs: readonly number[], count: number): boolean {
  const cad = session?.header?.agentPreset === 'cad';
  const entries = [];
  for (const seq of sourceEventSeqs) {
    const event = session.eventAt(seq);
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue;
    entries.push({ seq, type: event.type, content: session.deriveEventMessage(event).content });
  }
  const targets = selectOffloadTargets(entries, count, cad);
  if (!targets) return false;
  session.append('image/offload', { targets });
  return true;
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
    if (!offloadOldestProtected(agent.session, agent.session.surface.nodes, failure.offloadImages)) return next();
    return Promise.resolve({ kind: 'retry' });
  });

  // Compaction summary waterfall: same, keyed off the LlmError the summary
  // request raised. Duck-typed on `code` so this module needs no dsh-llm import.
  ctx.on('compaction/summary-error', ({ session, sourceEventSeqs, error, signal }: any, next: () => unknown) => {
    if ((error as any)?.code !== IMAGE_OFFLOAD_REQUIRED_CODE || (error as any)?.failure?.offloadImages === undefined) return next();
    signal?.throwIfAborted();
    if (!offloadOldestProtected(session, sourceEventSeqs, error.failure.offloadImages)) return next();
    return true;
  });

  // Per-preset image window (DESGIGN §16.4): every request carries its
  // sessionId; a 造物模式 session over the window gets a proactive offload
  // decision so the NEXT request fits. Standard-mode sessions are exempt —
  // that is the whole point of doing this here instead of in the route config.
  const windowInFlight = new Set<string>();
  ctx.on('llm/stream', (options: any, next: () => unknown) => {
    const sessionId: string | undefined = options?.sessionId;
    // Auxiliary calls (session-title, compaction) neither carry the
    // conversation's image load nor should drive the window.
    if (sessionId && !options?.purpose && !windowInFlight.has(sessionId)) {
      windowInFlight.add(sessionId);
      void Promise.resolve()
        .then(() => enforceSessionWindow(sessionsRef(ctx), options))
        .catch((e) => ctx.logger?.warn?.(`cad-harness: image window check failed: ${String((e as Error)?.message ?? e)}`))
        .finally(() => windowInFlight.delete(sessionId));
    }
    return next();
  });
}

/** The sessions service reference, resolved lazily (mount may still be polling). */
function sessionsRef(ctx: any): any {
  return ctx.reflect.get('sessions');
}

/**
 * The per-preset window decision for one observed request. Returns what was
 * done so the acceptance can pin the behavior without a live dsh:
 * `null` = not applicable (no session / not a cad session / under window),
 * otherwise `{ preset, retained, excess, appended }`.
 */
export function enforceSessionWindow(sessions: any, options: { sessionId?: string; messages?: any[] }):
  { preset: string | null; retained: number; excess: number; appended: boolean } | null {
  const sessionId = options?.sessionId;
  if (!sessionId || typeof sessions?.get !== 'function') return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  // The preset is a session CREATION fact (dsh accepts switching only while
  // the session is blank), so the header is the authoritative source.
  const preset: string | null = session.header?.agentPreset ?? null;
  if (preset !== 'cad') return null;
  const retained = countRetainedImages(options?.messages);
  const excess = retained - CAD_IMAGE_WINDOW;
  if (excess <= 0) return { preset, retained, excess, appended: false };
  const appended = offloadOldestProtected(session, session.surface.nodes, excess);
  return { preset, retained, excess, appended };
}
