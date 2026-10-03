// Client half entry: CAD viewer lives in the right sidebar as a tab, so the
// conversation keeps the center column (classic directory-workspace-viewer
// three-column layout).
//
// Services: `connection` (RPC + fetch), `slots` (tab body registration),
// `sidebarRight` (open/focus the tab), `sidebarRightTabs` (declare the type).

import React from 'react';
import { CadPanel, setClientServices } from './panel';
import { refreshProjectScope, setProjectServices, withProject } from './project';

/** Required services (cordis fiber inject). */
export const inject = ['connection', 'slots', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'conversation'];

export const name = 'cad-harness-client';

/** Tab type identity; also the slot key for the tab body. */
const TAB_ID = 'cad-harness:viewer';
const TAB_KIND = 'cad-viewer';

/** Client plugin body: declare the tab type, register the body, open it. */
export function apply(ctx: any) {
  setClientServices({ connection: ctx.connection, sessions: ctx.sessions, conversation: ctx.conversation, root: ctx });
  setProjectServices({ sessions: ctx.sessions });

  ctx.effect(() => {
    // 1. Declare the tab type (page kind, opened by openTab).
    const disposeType = ctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      title: () => 'CAD 预览',
    });

    // 2. Register the tab body. The body receives useTabInfo() via context;
    // the viewer does not need navigation state.
    const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID },
        CadPanel,
      ),
    );

    return () => {
      disposeBody?.();
      disposeType?.();
    };
  }, 'cad-harness: right sidebar tab');

  // 3. Deliberately NO auto-open on startup. This plugin may be installed in a
  // general-purpose workspace (a code repo, a docs project), where a preview
  // panel that pops up on every UI load is noise. Instead:
  //   - the tab is declared (step 1), so the user can click it in the right dock;
  //   - the tab is opened ON DEMAND when CAD activity is detected, i.e. when the
  //     session model actually runs a CAD tool (a new version appears).
  // The first poll only records a baseline, so loading the UI never pops it up.
  ctx.effect(() => {
    let disposed = false;
    let lastSeen: number | null = null;

    const openTab = (reason: string) => {
      let attempts = 0;
      const tryOpen = () => {
        attempts++;
        try {
          ctx.sidebarRight.openTab(TAB_KIND);
          console.info('[cad-harness] tab opened on', reason);
        } catch {
          // openTab before the dock exists is swallowed — retry briefly.
          if (attempts < 8 && !disposed) setTimeout(tryOpen, 1000);
        }
      };
      tryOpen();
    };

    const pollActivity = async () => {
      try {
        // Activity is per project: the panel is about to open on THIS session's
        // corpus, so an old project's timestamps must not open it here — and a
        // project with no parts at all is perfectly normal.
        // A project switch re-baselines: what was "new" in the previous
        // project says nothing about this one.
        const { switched } = refreshProjectScope();
        if (switched) lastSeen = null;
        // The whole tree, not just versions: a finished validation run is CAD
        // activity too, and it is exactly what the human wants to look at next.
        const res = await fetch(withProject('/api/cad/products'));
        if (!res.ok) return;
        const data = await res.json() as {
          parts?: { versions?: { timestamp?: string }[]; runs?: { timestamp?: string }[] }[];
          scene?: { timestamp?: string }[];
        };
        const newest = (data.parts ?? []).reduce((m, p) => {
          const own = [...(p.versions ?? []), ...(p.runs ?? [])]
            .reduce((n, r) => Math.max(n, Date.parse(r.timestamp ?? '') || 0), 0);
          return Math.max(m, own);
        }, (data.scene ?? []).reduce((m, r) => Math.max(m, Date.parse(r.timestamp ?? '') || 0), 0));
        if (lastSeen === null) { lastSeen = newest; return; } // baseline: no popup
        if (newest > lastSeen) { lastSeen = newest; openTab('CAD activity'); }
      } catch { /* route absent or offline: stay quiet */ }
    };

    void pollActivity();
    const timer = setInterval(() => { if (!disposed) void pollActivity(); }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, 'cad-harness: open tab on CAD activity');

  // 4. Explicit one-click activation control. Declaring a tab type does NOT put
  // a visible entry in the right dock (its entries only appear inside the guide
  // picker), so contribute a small toggle to the session header utilities —
  // a *list* slot, so no shipped control is shadowed (header.corner is single
  // and owned by the sidebar-right expand button).
  ctx.effect(() => {
    const openCadTab = () => {
      try {
        ctx.sidebarRight.openTab(TAB_KIND);
      } catch (e) {
        console.warn('[cad-harness] openTab from header control failed:', e);
      }
    };
    const CadOpenControl = () => React.createElement('button', {
      type: 'button',
      title: '打开 CAD 预览面板',
      onClick: openCadTab,
      style: {
        background: 'transparent',
        border: '1px solid currentColor',
        borderRadius: 6,
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: 1.4,
        padding: '2px 8px',
        opacity: 0.85,
      },
    }, 'CAD');
    try {
      const dispose = ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
        { name: 'conversation.session.header.utilities', id: 'cad-open-control', order: 50 },
        CadOpenControl,
      ));
      console.info('[cad-harness] header open control registered');
      return () => dispose?.();
    } catch (e) {
      console.warn('[cad-harness] header control registration failed:', e);
      return () => {};
    }
  }, 'cad-harness: header open control');
}
