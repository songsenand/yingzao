// Usage telemetry: observe every llm/stream call and record image counts plus
// a rough token estimate to <DSH_HOME>/cad/telemetry/usage.jsonl.
//
// PROFILE-wide, not per project: one observer sees every session at once, and
// what it measures is the request (images in context, tokens paid), not the
// design. Project data lives in project.ts.
//
// This is an OBSERVER on the llm/stream waterfall — the sanctioned use of that
// seam (retry/routing/observation). It never mutates the request: a loop-built
// request arrives deep-frozen precisely so listeners cannot rewrite it, which
// is also why image pruning lives in the adapter's offload policy (and in the
// session surface) rather than here.
//
// The image numbers are reported AFTER that policy, because that is what the
// route pays for; `imagesBeforePrune` keeps the raw history count beside it.

import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { telemetryRoot } from './project.ts';
import { DEEPSEEK_COUNT_QUANTUM, DEEPSEEK_KEEP_IMAGES, PI_AI_KEEP_BYTES, offloadedPrefixCount } from './image-budget.ts';

/** Conservative per-image token estimate used when no provider number exists. */
const IMAGE_TOKEN_ESTIMATE = Number(process.env.CAD_IMAGE_TOKEN_ESTIMATE ?? 1000);
/** Rough chars→tokens heuristic for text (CJK-heavy content skews high). */
const CHARS_PER_TOKEN = 3;

export interface UsageRecord {
  ts: string;
  model?: string;
  purpose?: string;
  /**
   * Image occurrences the ROUTE receives — after the adapter's image offload
   * policy replaced the oldest ones with text placeholders (image-budget.ts).
   * This is the count that costs visual tokens.
   */
  images: number;
  /**
   * Occurrences the session history carries, before that projection. Equal to
   * `images` on every record written before the budget existed (the old default
   * never fired), so old and new rows stay comparable.
   */
  imagesBeforePrune: number;
  generatePartRounds: number;
  imageTokensEstimate: number;
  textTokensEstimate: number;
  totalTokensEstimate: number;
}

interface CountableMessage {
  role: string;
  content?: unknown;
}

function countBlocks(
  content: unknown,
  stats: { images: number; rounds: number; textChars: number; imageBytes: number[] },
): void {
  if (!Array.isArray(content)) return;
  for (const block of content as Record<string, unknown>[]) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'image') {
      stats.images++;
      // Verified against the installed dsh: the offload executor
      // (dsh-compaction-image-offload) picks the OLDEST retained occurrences
      // across user messages and tool results alike — there is NO user-image
      // exemption. The mirror must see the same byte array the adapter does,
      // or reported `images` would overstate what survives.
      const attachment = block.attachment as { bytes?: unknown } | undefined;
      stats.imageBytes.push(typeof attachment?.bytes === 'number' ? attachment.bytes : 0);
    }
    if (block.type === 'text' && typeof block.text === 'string') stats.textChars += block.text.length;
    // Tool results nest content; a result carrying images is a generate_part
    // round (only generate_part attaches images today).
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      const before = stats.images;
      countBlocks(block.content, stats);
      if (stats.images > before) stats.rounds++;
    }
  }
}

/** Represented length of one image, exactly as the serving adapter accounts it. */
const rawLength = (bytes: number): number => bytes;
const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;
/** Per-image request-version cap the pi-ai route applies before accounting. */
const PI_AI_PER_IMAGE_CAP = 1024 * 1024;

/**
 * Which image budget applies to a request, and how that adapter accounts it.
 *
 * The usage record carries only a model id, not the adapter that served it, and
 * the two adapters prune on different axes: the native DeepSeek one has a count
 * budget, pi-ai has only a per-provider byte budget (applied at boot by
 * image-budget.ts). The ids this deployment actually runs are `deepseek-*` on
 * the native adapter and `glm-*` on pi-ai; anything unrecognised is treated as
 * pi-ai, whose byte budget reports MORE images than a count budget would —
 * over-reporting cost is the safe direction to be wrong in.
 */
function budgetFor(model: string | undefined): {
  maxImages?: number;
  maxBytes?: number;
  countQuantum: number;
  byteQuantum: number;
  represent: (bytes: number) => number;
} {
  const deepseek = typeof model === 'string' && /deepseek/i.test(model);
  return deepseek
    ? {
      maxImages: DEEPSEEK_KEEP_IMAGES,
      countQuantum: DEEPSEEK_COUNT_QUANTUM,
      byteQuantum: 1,
      represent: rawLength,
    }
    : {
      // Byte budget only: the installed pi-ai adapter has no count knob (see
      // image-budget.ts for the verified mechanism — the bound fires
      // IMAGE_OFFLOAD_REQUIRED and the offload executor prunes the oldest
      // occurrences, then the request retries).
      maxImages: undefined,
      maxBytes: PI_AI_KEEP_BYTES,
      countQuantum: 1,
      byteQuantum: 1,
      represent: (bytes: number) => base64Length(Math.min(bytes, PI_AI_PER_IMAGE_CAP)),
    };
}

/**
 * Build one usage record for a request. Exported so the acceptance script can
 * check the numbers this plugin reports against the projection the adapter
 * actually performs, on identical input.
 *
 * @param messages - request messages as the loop assembled them.
 * @param model - routed model id.
 * @param purpose - request purpose (`session-title`, compaction, ...).
 * @returns the record appended to usage.jsonl.
 */
export function measureUsage(
  messages: readonly CountableMessage[] | undefined,
  model?: string,
  purpose?: string,
): UsageRecord {
  const stats = { images: 0, rounds: 0, textChars: 0, imageBytes: [] as number[] };
  for (const m of messages ?? []) countBlocks(m?.content, stats);
  const budget = budgetFor(model);
  const pruned = offloadedPrefixCount(
    stats.imageBytes.map(budget.represent),
    budget.maxImages, budget.maxBytes, budget.countQuantum, budget.byteQuantum,
  );
  const inFlight = stats.images - Math.min(pruned, stats.images);
  const imageTokensEstimate = inFlight * IMAGE_TOKEN_ESTIMATE;
  const textTokensEstimate = Math.ceil(stats.textChars / CHARS_PER_TOKEN);
  return {
    ts: new Date().toISOString(),
    model,
    purpose,
    images: inFlight,
    imagesBeforePrune: stats.images,
    generatePartRounds: stats.rounds,
    imageTokensEstimate,
    textTokensEstimate,
    totalTokensEstimate: imageTokensEstimate + textTokensEstimate,
  };
}

const recent: UsageRecord[] = [];
const MAX_RECENT = 300;

export function registerUsageObserver(ctx: any): void {
  const usageDir = telemetryRoot();

  ctx.on('llm/stream', (options: { messages?: CountableMessage[]; model?: string; purpose?: string }, next: () => AsyncIterable<unknown>) => {
    try {
      const record = measureUsage(options?.messages, options?.model, options?.purpose);
      recent.push(record);
      if (recent.length > MAX_RECENT) recent.shift();
      void (async () => {
        try {
          await mkdir(usageDir, { recursive: true });
          await appendFile(join(usageDir, 'usage.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
        } catch { /* telemetry must never break the stream */ }
      })();
    } catch { /* ditto */ }
    return next();
  });
}

/** GET /api/cad/usage — recent records + aggregate of the last 20 calls. */
export async function usageReport(): Promise<Record<string, unknown>> {
  let lines: UsageRecord[] = recent;
  try {
    const raw = await readFile(join(telemetryRoot(), 'usage.jsonl'), 'utf8');
    lines = raw.split('\n').filter(Boolean).slice(-MAX_RECENT).map((l) => JSON.parse(l));
  } catch { /* fall back to in-memory */ }
  const last20 = lines.slice(-20);
  const sum = (f: (r: UsageRecord) => number) => last20.reduce((a, r) => a + f(r), 0);
  // Rows written before the image budget existed carry no `imagesBeforePrune`;
  // for those, `images` WAS the raw count (the old default never fired), so the
  // fallback is exact rather than a guess.
  const before = (r: UsageRecord) => r.imagesBeforePrune ?? r.images;
  return {
    calls: lines.length,
    last20: {
      calls: last20.length,
      imagesTotal: sum((r) => r.images),
      imagesPruned: sum((r) => Math.max(0, before(r) - r.images)),
      imagesBeforePruneTotal: sum(before),
      imageTokensEstimate: sum((r) => r.imageTokensEstimate),
      textTokensEstimate: sum((r) => r.textTokensEstimate),
      totalTokensEstimate: sum((r) => r.totalTokensEstimate),
    },
    records: last20,
    imageBudget: {
      deepseek: { maxImagesPerRequest: DEEPSEEK_KEEP_IMAGES, imageOffloadCountQuantum: DEEPSEEK_COUNT_QUANTUM },
      piAi: { maxRequestImageBytes: PI_AI_KEEP_BYTES, mechanism: 'byte bound → IMAGE_OFFLOAD_REQUIRED → oldest-first offload + retry' },
      note: 'declared for llm-deepseek in cordis.patch.yml; applied for llm-pi-ai by image-budget.ts',
    },
    note: `image token estimate = ${IMAGE_TOKEN_ESTIMATE}/image (set CAD_IMAGE_TOKEN_ESTIMATE to calibrate); `
      + '`images` counts what the route receives after old-turn images are replaced by text placeholders',
  };
}
