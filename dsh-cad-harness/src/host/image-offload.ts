// Protected image-offload executor (plugin-side replacement for the stock
// `@deepseek-ai/dsh-compaction-image-offload`, which cordis.patch.yml disables).
//
// WHY THIS EXISTS: the stock executor offloads the OLDEST retained occurrences
// with no exemption — verified against dsh 0.2.0-rc.2 (DESGIGN §15.1 #4) — and
// the user's reference image is always the oldest thing in a session. This
// module is a faithful port of the stock implementation (lib/index.js, 154
// lines) with ONE behavioral difference:
//
//   * images sitting at the TOP LEVEL of a `user/message` event — the files a
//     human drags into the session — are never selected for offload. Tool
//     results (`tool/result`) remain fully prunable; that is where the render
//     views live and what the budget is for.
//
// Everything else is byte-for-byte the same shape: the same `image/offload`
// durable decision event, the same projection validation, the same error
// waterfall semantics (`agent/request-error` → {kind:"retry"};
// `compaction/summary-error` → true), so routes and the session surface see
// no difference other than which occurrences get omitted.
//
// UPGRADE SAFETY: this lives in our repository, so dsh upgrades cannot clobber
// it. The cost is that it tracks two internal seams —
// `sessions.registerMessageProjection` and the `image/offload` event shape.
// `scripts/accept-image-offload.mjs` pins both: the projection is exercised
// against the stock module's own validation semantics, and the composed-tree
// check proves the stock row is disabled (exactly one executor may own the
// seam). If a dsh upgrade changes the seam shape, this acceptance fails loud.

/** The stable failure code the adapters raise when a request exceeds its image budget. */
const IMAGE_OFFLOAD_REQUIRED_CODE = 'IMAGE_OFFLOAD_REQUIRED';

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
 * Select the oldest retained input-image occurrences to omit, skipping
 * top-level images of user messages. Image indexes count every occurrence,
 * including previously offloaded ones, within each message.
 *
 * @param entries - input message events in the failed request's order: `{seq,
 *   type, content}` where `type` is `user/message` or `tool/result` and
 *   `content` is the message's content block array.
 * @param count - additional retained occurrences the adapter needs omitted.
 * @returns targets for a `image/offload` decision, or `null` when nothing
 *   prunable remained (the caller must let the error waterfall proceed).
 */
export function selectOffloadTargets(
  entries: readonly { seq: number; type: string; content: any }[],
  count: number,
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
          if (block.offloaded !== true && !isUserTopLevel) {
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
      if (source.type === 'user/message' && hasTopLevelImage(message.content)) {
        // A user-message top-level image being selected means a selector
        // without protection produced this event — refuse rather than replay.
        throw new Error(`image/offload: target seq ${seq} would offload a protected user image`);
      }
      messages.set(seq, offloadMessageImages(message, target['imageIndexes']));
    }
    return messages;
  },
};

/**
 * Record one protected offload decision on the session and report whether any
 * prunable occurrence remained. Mirrors the stock executor's contract:
 * `true` means a decision was appended and the request should retry.
 */
export function offloadOldestProtected(session: any, sourceEventSeqs: readonly number[], count: number): boolean {
  const entries = [];
  for (const seq of sourceEventSeqs) {
    const event = session.eventAt(seq);
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue;
    entries.push({ seq, type: event.type, content: session.deriveEventMessage(event).content });
  }
  const targets = selectOffloadTargets(entries, count);
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
    ctx.logger?.info?.('cad-harness: protected image-offload executor mounted (user-message images exempt)');
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
}
