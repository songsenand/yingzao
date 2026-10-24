// "What did I look at lately?" — the navigator's most-used entrance.
//
// The panel used to open on whatever the corpus happened to order first; the
// thing a person wants after an interruption is the thing they were looking at
// when it happened. Kept in localStorage rather than the corpus: it is a view
// preference of THIS browser, not a fact about the project (the corpus stays
// readable by anyone, and nothing here can make a version current).
//
// Addresses use the same grammar as the read port: `v066`, `r059`, `p005`,
// `f:<relative path>`.

const KEY = 'cad.recent';
const MAX = 8;

export function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, MAX);
  } catch {
    return [];
  }
}

/** Record a visit; returns the new list (most recent first, deduped). */
export function pushRecent(id: string): string[] {
  if (!id) return loadRecent();
  const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}
