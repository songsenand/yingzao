// Which render views a version ATTACHES to the conversation.
//
// Separate from tools.ts because this is a policy with three distinct answers,
// and the old inline `a.views.length` test collapsed two of them:
//
//   views undefined -> attach all four (the default, for a shape you must SEE)
//   views []        -> attach NONE (register the version, spend no image budget;
//                      the panel still loads model.stl, so the human sees it)
//   views [subset]  -> attach the matched views
//
// An unrecognised name must never silently attach nothing: fall back to all and
// return a warning the caller surfaces. Callers pass `warning` into their
// warnings list; this module never decides what to do with it.

export interface RenderedView {
  view: string;
}

export interface AttachedViews<T extends RenderedView> {
  attached: T[];
  warning: string | null;
}

export function selectAttachedViews<T extends RenderedView>(
  renders: T[] | undefined,
  views: string[] | undefined,
): AttachedViews<T> {
  const all = renders ?? [];
  if (views === undefined) return { attached: all, warning: null };
  if (views.length === 0) return { attached: [], warning: null };
  const matched = all.filter((r) => views.includes(r.view));
  if (matched.length > 0) return { attached: matched, warning: null };
  return {
    attached: all,
    warning: `views ${JSON.stringify(views)} matched no rendered view — all views attached`,
  };
}
