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
import { DEEPSEEK_COUNT_QUANTUM, DEEPSEEK_KEEP_IMAGES, offloadedPrefixCount } from './image-budget.ts';

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

/**
 * Which image budget applies to a request, and how that adapter accounts it.
 *
 * DESGIGN §16–17: the plugin applies NO route-level budget — standard mode
 * runs on factory defaults (no proactive pruning on either route). The
 * deepseek count numbers below PREDICT the 造物 (cad) session window the
 * executor enforces (24 retained), which is the closest honest model of what
 * a CAD request costs; every other preset has no pruning predicted. A
 * user-configured pathological-attachment budget fails a request loudly
 * instead of silently pruning — that path is not modeled here.
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
      // No route budget on pi-ai: what keeps a CAD session at 24 images is
      // the executor's session window, not this route.
      maxImages: undefined,
      maxBytes: undefined,
      countQuantum: 1,
      byteQuantum: 1,
      represent: base64Length,
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

/**
 * One image-window decision, written by the offload executor (DESGIGN §23.5).
 *
 * WHY THIS EXISTS: the microscope5 post-mortem could not answer "did the cad
 * image window even run?" from the corpus — the answer had to be reconstructed
 * from the session log's preset events. Every decision and every skip is now
 * data, including WHY it did not apply (`preset-not-cad`, `aux-purpose`, …),
 * which is exactly the field that would have made that question a one-liner.
 */
export interface ImageWindowRecord {
  ts: string;
  sessionId?: string;
  /** Outcome of the check: applied = pruned, under-window = nothing to do. */
  outcome: 'applied' | 'under-window' | 'preset-not-cad' | 'no-session' | 'no-service'
    | 'aux-purpose' | 'in-flight' | 'error';
  /** The session's EFFECTIVE preset, as read (projection first, header fallback). */
  preset: string | null;
  /** Retained image occurrences seen in the request, and the excess over the window. */
  retained?: number;
  excess?: number;
  window?: number;
  /** Pairs/pruned occurrences when a decision was appended. */
  pruned?: number;
  targets?: { seq: number; images: number }[];
  note?: string;
}

const windowRecent: ImageWindowRecord[] = [];
const MAX_WINDOW_RECENT = 200;

/** Append one window record; never throws, never blocks a request. */
export function recordImageWindow(record: ImageWindowRecord): void {
  windowRecent.push(record);
  if (windowRecent.length > MAX_WINDOW_RECENT) windowRecent.shift();
  if (process.env.CAD_TELEMETRY_DISABLE === '1') return;
  void (async () => {
    try {
      const dir = telemetryRoot();
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, 'image-window.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
    } catch { /* telemetry must never break the stream */ }
  })();
}

/** The last window records, with counts per outcome (for the panel and scripts). */
export function imageWindowReport(): Record<string, unknown> {
  const byOutcome: Record<string, number> = {};
  for (const r of windowRecent) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  const applied = windowRecent.filter((r) => r.outcome === 'applied');
  return {
    records: windowRecent.length,
    byOutcome,
    lastApplied: applied.slice(-3),
    note: 'applied = the cad window pruned; preset-not-cad = the session is not 造物模式 (the microscope5 case)',
  };
}

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
      deepseek: { cadWindow: DEEPSEEK_KEEP_IMAGES, quantum: DEEPSEEK_COUNT_QUANTUM, note: 'session-level window for the cad preset, enforced by the offload executor' },
      piAi: { budget: 'none', note: 'factory defaults on every preset; the cad window is session-level (image-offload.ts)' },
      note: 'route knobs stay at dsh defaults for every preset; see DESGIGN §16–17',
    },
    imageWindow: imageWindowReport(),
    note: `image token estimate = ${IMAGE_TOKEN_ESTIMATE}/image (set CAD_IMAGE_TOKEN_ESTIMATE to calibrate); `
      + '`images` counts what the route receives after old-turn images are replaced by text placeholders',
  };
}
