// Per-version visual review record: the artifact behind "the model has LOOKED at
// this version before delivery".
//
// WHY a sidecar and not a run: the unit is a VERSION, not a job. A review is
// about one piece of geometry ("I looked at v040 from the top and the D hole is
// a D hole, not a slot"), and a version can be re-reviewed after a fix without
// inventing a new run kind. The delivery audit reads the same file, so the gate
// and the record cannot drift.
//
// WHAT IT DOES NOT CLAIM: the record says "these views were rendered and put in
// front of the model, and the model wrote down what it saw". A machine cannot
// prove that an image was understood, so the honest evidence is the attachment
// + the note, not a green checkmark. `delivery_audit` reports a missing/stale
// record as blocked, and a human can read the note to see whether the claim is
// substantive.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './file-lock.ts';
import type { VersionStore } from './version.ts';

/** Views a delivery review must contain. Top catches cuts/notches in plan; iso
 *  catches the 3D relationship that a flat projection hides. */
export const REQUIRED_REVIEW_VIEWS = ['top', 'iso'] as const;

export type VisualReviewSource = 'review_visual' | 'render_part';

export interface VisualReviewImage {
  view: string;
  /** Relative to the version dir (or an absolute path for legacy records). */
  file: string;
  bytes: number;
  sha256: string;
}

export interface VisualReviewRecord {
  schemaVersion: 1;
  versionId: string;
  /** The latest review moment. Must be >= the version's timestamp. */
  reviewedAt: string;
  /** Union of every view ever reviewed on this version. */
  views: string[];
  /** Union of section cuts; a section is often the only view that shows an
   *  internal feature (a D hole's flat, a pocket's floor). */
  sections: { axis: 'x' | 'y' | 'z'; fraction: number }[];
  /** One note per review call, in order. The model's words, not a verdict. */
  notes: string[];
  images: VisualReviewImage[];
  source: VisualReviewSource | 'mixed';
}

export function visualReviewPath(store: Pick<VersionStore, 'root'>, versionId: string): string {
  return join(store.root, 'versions', versionId, 'visual-review.json');
}

/** Read a review record, or undefined when the version has never been reviewed. */
export async function readVisualReview(
  store: Pick<VersionStore, 'root'>,
  versionId: string,
): Promise<VisualReviewRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(visualReviewPath(store, versionId), 'utf8')) as VisualReviewRecord;
    if (raw?.schemaVersion !== 1 || raw.versionId !== versionId) return undefined;
    return {
      ...raw,
      views: Array.isArray(raw.views) ? raw.views : [],
      sections: Array.isArray(raw.sections) ? raw.sections : [],
      notes: Array.isArray(raw.notes) ? raw.notes : [],
      images: Array.isArray(raw.images) ? raw.images : [],
    };
  } catch {
    return undefined;
  }
}

/** A review is fresh when it happened at or after the version was written. */
export function reviewIsFresh(record: VisualReviewRecord | undefined, versionTimestamp: string): boolean {
  if (!record) return false;
  const reviewed = Date.parse(record.reviewedAt);
  const version = Date.parse(versionTimestamp);
  if (!Number.isFinite(reviewed) || !Number.isFinite(version)) return false;
  return reviewed >= version;
}

/** Does the record contain every view the delivery gate requires? */
export function reviewCoversRequiredViews(record: VisualReviewRecord | undefined): boolean {
  if (!record) return false;
  return REQUIRED_REVIEW_VIEWS.every((v) => record.views.includes(v));
}

/**
 * Merge one review observation into the version's record.
 *
 * Merging (rather than replacing) is deliberate: the model may look at the top
 * in one call and the iso in the next. A later top review must not erase the
 * earlier iso proof. `reviewedAt` is the latest observation, which is what the
 * freshness check compares to the version timestamp.
 */
export async function recordVisualReview(input: {
  store: Pick<VersionStore, 'root'>;
  versionId: string;
  views: string[];
  sections?: { axis: 'x' | 'y' | 'z'; fraction: number }[];
  note: string;
  images?: VisualReviewImage[];
  source: VisualReviewSource;
  at?: string;
}): Promise<VisualReviewRecord> {
  const at = input.at ?? new Date().toISOString();
  const existing = await readVisualReview(input.store, input.versionId);
  const views = [...new Set([...(existing?.views ?? []), ...input.views])];
  const sections = [...(existing?.sections ?? [])];
  for (const s of input.sections ?? []) {
    if (!sections.some((x) => x.axis === s.axis && Math.abs(x.fraction - s.fraction) < 1e-6)) {
      sections.push({ axis: s.axis, fraction: +s.fraction.toFixed(4) });
    }
  }
  const notes = [...(existing?.notes ?? []), input.note].filter((n) => n.trim().length > 0);
  const images = [...(existing?.images ?? [])];
  for (const image of input.images ?? []) {
    const i = images.findIndex((x) => x.view === image.view);
    if (i >= 0) images[i] = image;
    else images.push(image);
  }
  const sources = new Set<VisualReviewSource>();
  if (existing?.source === 'mixed') sources.add('review_visual').add('render_part');
  else if (existing?.source) sources.add(existing.source);
  sources.add(input.source);
  const record: VisualReviewRecord = {
    schemaVersion: 1,
    versionId: input.versionId,
    reviewedAt: at,
    views,
    sections,
    notes,
    images,
    source: sources.size === 1 ? [...sources][0]! : 'mixed',
  };
  await writeJsonAtomic(visualReviewPath(input.store, input.versionId), record);
  return record;
}
