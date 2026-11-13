// Which conversation produced a CAD write.
//
// WHY THIS EXISTS. The right-side CAD tab is opened automatically when a new
// version or run appears in the corpus the panel is watching. That watcher only
// knew "something changed in this project", not WHO changed it, so another
// conversation running CAD tools in the same project could pop this
// conversation's panel open with unrelated content.
//
// The tool runtime hands every tool call its `exec` (agent → session header),
// but `saveVersion` / `beginRun` are called several layers below that and know
// nothing about sessions. Rather than thread a session argument through every
// store call, the tool-registration wrapper runs each call inside an
// AsyncLocalStorage scope; the writers read the ambient id and stamp it onto the
// row they commit. AsyncLocalStorage (not a module variable) keeps concurrent
// tool calls from two conversations from overwriting each other's identity.

import { AsyncLocalStorage } from 'node:async_hooks';

const sessionScope = new AsyncLocalStorage<string | undefined>();

/**
 * Run one tool call with the session that made it.
 *
 * @param sessionId - the calling session, or undefined for headless callers.
 * @param fn - the tool body; every async operation it starts inherits the id.
 */
export function withOriginSession<T>(sessionId: string | undefined, fn: () => T): T {
  return sessionScope.run(sessionId, fn);
}

/**
 * The session currently executing a tool call, or undefined.
 *
 * Undefined is a real answer: HTTP routes (a human import/approval) and
 * maintenance scripts are not conversations, and their writes must not be
 * attributed to whichever conversation happens to be on screen.
 */
export function originSessionId(): string | undefined {
  const id = sessionScope.getStore();
  return typeof id === 'string' && id.trim() ? id : undefined;
}
