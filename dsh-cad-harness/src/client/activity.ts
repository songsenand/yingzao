// Should a new CAD artifact open the right-side viewer in THIS conversation?
//
// The watcher must be able to say "no" for a perfectly valid reason: another
// conversation running CAD tools in the same project is activity, but it is not
// this conversation's activity. Keeping that decision in a pure function makes
// the rule testable without mounting the sidebar, a session store or React.

import type { CadActivity } from '../shared/types.ts';

export type ActivityOpenReason =
  /** First observation: record the baseline, never pop the panel. */
  | 'baseline'
  /** No new artifact since the last observation. */
  | 'stale'
  /** The tree carries no provenance (older host or an empty corpus). */
  | 'no-activity'
  /** We cannot tell which conversation is on screen. */
  | 'no-session'
  /** The writer predates provenance (or was an HTTP route/script). */
  | 'no-provenance'
  /** A different conversation wrote it. */
  | 'other-session'
  /** The conversation on screen wrote it. */
  | 'current';

export interface ActivityOpenDecision {
  /** The newest timestamp to remember for the next comparison. */
  lastSeen: number;
  open: boolean;
  reason: ActivityOpenReason;
}

/**
 * Decide whether the newest activity justifies opening the CAD tab.
 *
 * @param input.activity - newest commit and its `sessionId`, when known.
 * @param input.newestAt - newest timestamp in the tree (`Date.parse` value).
 * @param input.lastSeen - previous newestAt, or null before the baseline.
 * @param input.sessionId - the conversation currently on screen, or ''.
 */
export function decideActivityOpen(input: {
  activity?: CadActivity;
  newestAt: number;
  lastSeen: number | null;
  sessionId: string;
}): ActivityOpenDecision {
  const { activity, newestAt, lastSeen, sessionId } = input;
  if (lastSeen === null) return { lastSeen: newestAt, open: false, reason: 'baseline' };
  if (newestAt <= lastSeen) return { lastSeen, open: false, reason: 'stale' };
  if (!activity) return { lastSeen: newestAt, open: false, reason: 'no-activity' };
  if (!sessionId) return { lastSeen: newestAt, open: false, reason: 'no-session' };
  if (!activity.sessionId) return { lastSeen: newestAt, open: false, reason: 'no-provenance' };
  if (activity.sessionId !== sessionId) return { lastSeen: newestAt, open: false, reason: 'other-session' };
  return { lastSeen: newestAt, open: true, reason: 'current' };
}
