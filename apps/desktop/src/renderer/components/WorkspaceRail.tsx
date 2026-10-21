/**
 * The spaces, down the side, with their conversations under them.
 *
 * A space is the directory an agent works in — the word on screen for what this
 * app used to call a folder. The code kept the old word: this component's name,
 * its props, its classes and the store calls all still say workspace, because
 * renaming those means migrating a file on disk and a schema rather than
 * changing copy. The split is deliberate rather than an oversight, so the next
 * reader does not "fix" one half of it.
 *
 * The Bots heading is both a switcher and a door: the avatars below it change
 * whose conversations the tree shows, and the `+` beside the heading makes
 * another bot without a trip through Settings.
 *
 * Every agent shares the list, so this is navigation over places, not over
 * agents. The conversation on screen is always under the space it belongs to,
 * because a rail that hid it would look like the app had lost it.
 *
 * Two groups are not spaces. **Social** holds what the app itself started — a
 * Discord mention arrives in whatever space happened to be current and has
 * nothing to do with it — and **Other chats** holds conversations from before
 * spaces existed, or ones whose space has since been forgotten. Both are
 * rendered flat, with no "new chat" button, because neither is a place.
 */
import {useEffect, useMemo, useRef, useState} from 'react';

import type {AgentProfile, SessionSummary, Workspace} from '@marimo/protocol';

import {clampRailWidth, MAX_RAIL_WIDTH, MIN_RAIL_WIDTH} from '../layout.js';
import {groupSessions} from '../workspace-groups.js';
import {BotAvatar} from './BotAvatar.js';
import {KeepRunning} from './KeepRunning.js';
import {SessionMenu} from './SessionMenu.js';
import {WorkspaceMenu} from './WorkspaceMenu.js';
import type {PopoverAnchor} from './Popover.js';

/** Which row's menu is open, and where its trigger was when it opened. */
type OpenMenu =
  | {kind: 'session'; sessionId: string; anchor: PopoverAnchor}
  | {kind: 'workspace'; workspaceId: string; anchor: PopoverAnchor};

/** Which name is being edited in place. */
type Editing = {kind: 'session' | 'workspace'; id: string; value: string};

export function WorkspaceRail({
  bots,
  activeProfileId,
  workspaces,
  sessions,
  activeSessionId,
  activeWorkspaceId,
  disabled,
  width,
  onResize,
  onResizeEnd,
  onSelectProfile,
  onNewBot,
  onOpenSession,
  onNewSession,
  onSelectWorkspace,
  onLoadWorkspace,
  onRenameWorkspace,
  onRemoveWorkspace,
  onOpenWorkspace,
  onMoveSession,
  onRenameSession,
  onDeleteSession,
}: {
  /** Every bot in the install, in the roster's own order. */
  bots: AgentProfile[];
  /** The bot whose conversations the Spaces tree below is showing. */
  activeProfileId: string | null;
  workspaces: Workspace[];
  sessions: SessionSummary[];
  activeSessionId: string | null;
  activeWorkspaceId: string | null;
  disabled: boolean;
  /** The rail's live width, in pixels. */
  width: number;
  /** Applies a width while the handle is moving. */
  onResize: (width: number) => void;
  /** Writes the width the drag settled on, so it survives a restart. */
  onResizeEnd: (width: number) => void;
  onSelectProfile: (profileId: string) => void;
  /** Opens the New bot dialog, the same one Settings uses. */
  onNewBot: () => void;
  onOpenSession: (sessionId: string) => void;
  onNewSession: (workspaceId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onLoadWorkspace: () => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  onRemoveWorkspace: (workspaceId: string) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onMoveSession: (sessionId: string, workspaceId: string | null) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
}): React.JSX.Element {
  const groups = useMemo(
    () => groupSessions({workspaces, sessions, activeSessionId}),
    [workspaces, sessions, activeSessionId],
  );

  /** Collapsed by id; expanded is the default, which is the quieter state. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  /*
   * Escape has to beat the blur that follows it. Unmounting the input fires a
   * blur whose handler still closes over the old draft, so a cancelled edit
   * would otherwise be committed on the way out. Set before the state change,
   * consumed by whichever handler runs first, and cleared when the next edit
   * begins.
   */
  const cancelled = useRef(false);
  /** Whether the rail's right edge is being dragged, so it can stay lit. */
  const [resizing, setResizing] = useState(false);
  /*
   * The drag in flight. `startWidth` is measured from the element rather than
   * taken from the prop, so a width the window clamped is the width the pointer
   * starts from and the first move does not jump.
   */
  const drag = useRef<{
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);

  /*
   * The body class the drag puts on the whole window has to come off on every
   * path out, including this component disappearing mid-drag: Settings replaces
   * the window, and a stale resize cursor would outlive the rail.
   */
  useEffect(
    () => () => {
      document.body.classList.remove('resizing-rail');
    },
    [],
  );

  /*
   * The space of the conversation on screen is never collapsed. Selecting
   * another space does not move it, so this only matters after the user
   * collapsed the space and then opened one of its chats from elsewhere.
   */
  const openWorkspaceId =
    sessions.find((session) => session.id === activeSessionId)?.workspaceId ??
    activeWorkspaceId;
  useEffect(() => {
    const workspaceId = openWorkspaceId;
    if (workspaceId === undefined || workspaceId === null) {
      return;
    }
    setCollapsed((current) => {
      if (!current.has(workspaceId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(workspaceId);
      return next;
    });
  }, [openWorkspaceId]);

  const toggle = (workspaceId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  };

  /** Where a menu is drawn from: the trigger's place right now. */
  const anchorOf = (element: HTMLElement): PopoverAnchor => {
    const rect = element.getBoundingClientRect();
    return {top: rect.top, bottom: rect.bottom, left: rect.left};
  };

  const beginEdit = (next: Editing): void => {
    cancelled.current = false;
    setEditing(next);
  };

  const commitEdit = (): void => {
    const draft = editing;
    if (draft === null || cancelled.current) {
      cancelled.current = false;
      return;
    }
    setEditing(null);
    const value = draft.value.trim();
    if (value.length === 0) {
      return;
    }
    if (draft.kind === 'workspace') {
      const workspace = workspaces.find((entry) => entry.id === draft.id);
      if (workspace !== undefined && value !== workspace.name) {
        onRenameWorkspace(draft.id, value);
      }
      return;
    }
    const session = sessions.find((entry) => entry.id === draft.id);
    if (session !== undefined && value !== session.title) {
      onRenameSession(draft.id, value);
    }
  };

  const editInput = (draft: Editing, what: string): React.JSX.Element => (
    <input
      className="rail-row-input"
      value={draft.value}
      aria-label={what}
      autoFocus
      spellCheck={false}
      onChange={(event) => {
        setEditing({...draft, value: event.target.value});
      }}
      onBlur={commitEdit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitEdit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelled.current = true;
          setEditing(null);
        }
      }}
    />
  );

  /*
   * The rail's right edge, dragged the way the documents drawer's left edge is.
   *
   * The width is layout rather than a fact about a bot or a Space, so it is
   * applied to the live column while the pointer moves and written once the
   * drag settles — see App.
   */
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current !== null) {
      return;
    }
    event.preventDefault();
    // `preventDefault` stops the click from selecting text; focus still has to
    // be put back on the handle so a drag can be followed by the arrow keys.
    event.currentTarget.focus();
    const startWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? width;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {startX: event.clientX, startWidth, width: startWidth};
    // The pointer spends the drag over the conversation, so the element under
    // it does not keep the resize cursor by itself.
    document.body.classList.add('resizing-rail');
    setResizing(true);
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current === null) {
      return;
    }
    // The rail's right edge moving right makes it wider.
    const next = clampRailWidth(
      current.startWidth + (event.clientX - current.startX),
    );
    current.width = next;
    onResize(next);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current === null) {
      return;
    }
    drag.current = null;
    document.body.classList.remove('resizing-rail');
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResizeEnd(current.width);
  };

  /**
   * Arrow keys move the edge by a line, Shift by a wider step. A resize handle
   * that only answers a mouse is a control half the users cannot operate.
   */
  const resizeByKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16;
    let next: number;
    if (event.key === 'ArrowLeft') {
      next = clampRailWidth(width - step);
    } else if (event.key === 'ArrowRight') {
      next = clampRailWidth(width + step);
    } else {
      return;
    }
    event.preventDefault();
    onResize(next);
    onResizeEnd(next);
  };

  const menuSession =
    menu?.kind === 'session'
      ? sessions.find((entry) => entry.id === menu.sessionId)
      : undefined;
  const menuWorkspace =
    menu?.kind === 'workspace'
      ? workspaces.find((entry) => entry.id === menu.workspaceId)
      : undefined;

  const sessionRows = (list: readonly SessionSummary[]): React.JSX.Element[] =>
    list.map((session) => {
      const isOpen = session.id === activeSessionId;
      if (editing?.kind === 'session' && editing.id === session.id) {
        return (
          <div
            className="rail-row"
            key={session.id}
            data-session-id={session.id}
          >
            {editInput(editing, 'Conversation name')}
          </div>
        );
      }
      return (
        <div
          className="rail-row"
          key={session.id}
          data-session-id={session.id}
          data-active={isOpen ? 'true' : undefined}
        >
          <button
            type="button"
            className="rail-row-title"
            aria-current={isOpen ? 'true' : undefined}
            title={session.title}
            onClick={() => {
              onOpenSession(session.id);
            }}
          >
            {session.title}
          </button>
          <span className="rail-row-when">{shortDate(session.updatedAt)}</span>
          <button
            type="button"
            className="rail-row-menu"
            aria-haspopup="menu"
            aria-expanded={
              menu?.kind === 'session' && menu.sessionId === session.id
            }
            aria-label={`Actions for ${session.title}`}
            onClick={(event) => {
              setMenu({
                kind: 'session',
                sessionId: session.id,
                anchor: anchorOf(event.currentTarget),
              });
            }}
          >
            ⋯
          </button>
        </div>
      );
    });

  return (
    <aside className="rail" aria-label="Bots and spaces">
      {/*
        The rail's right edge, and the only pointer target that is not content.
        It sits inside the aside rather than in a grid column of its own: a
        column for a six-pixel strip would be a second thing the layout has to
        keep in step with the width.
      */}
      <div
        className="rail-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuemin={MIN_RAIL_WIDTH}
        aria-valuemax={MAX_RAIL_WIDTH}
        aria-valuenow={width}
        data-resizing={resizing ? 'true' : undefined}
        title="Drag to resize"
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
        onKeyDown={resizeByKey}
      />
      <nav
        className="rail-list"
        // The menu is anchored to a rectangle that scrolls away beneath it.
        onScroll={() => {
          setMenu(null);
        }}
      >
        <section className="rail-bots" aria-label="Bots">
          <div className="rail-bots-head">
            <h2 className="rail-group-head">Bots</h2>
            <button
              type="button"
              className="rail-bots-new"
              title="New bot"
              aria-label="New bot"
              disabled={disabled}
              onClick={onNewBot}
            >
              +
            </button>
          </div>
          {bots.map((bot) => {
            const active = bot.id === activeProfileId;
            return (
              <button
                type="button"
                className="rail-bot"
                key={bot.id}
                aria-current={active ? 'true' : undefined}
                title={
                  active ? `${bot.name} is active` : `Switch to ${bot.name}`
                }
                onClick={() => {
                  onSelectProfile(bot.id);
                }}
              >
                <BotAvatar profile={bot} size="sm" />
                <span className="rail-bot-name">{bot.name}</span>
              </button>
            );
          })}
        </section>

        <div className="rail-spaces-head">
          <h2 className="rail-group-head">Spaces</h2>
          <button
            type="button"
            className="button button-quiet button-small"
            disabled={disabled}
            onClick={onLoadWorkspace}
          >
            Load a space…
          </button>
        </div>

        {groups.length === 0 && (
          <p className="rail-empty">
            No spaces yet. Load one and every bot can work in it.
          </p>
        )}

        {groups.map((group) => {
          if (group.kind !== 'workspace') {
            return (
              <section className="rail-group" key={group.kind}>
                <h2 className="rail-group-head">
                  {group.kind === 'social' ? 'Social' : 'Other chats'}
                </h2>
                {sessionRows(group.sessions)}
              </section>
            );
          }

          const workspace = group.workspace;
          const isOpen = !collapsed.has(workspace.id);
          const isActive = workspace.id === activeWorkspaceId;
          return (
            <section
              className="rail-workspace"
              key={workspace.id}
              data-workspace-id={workspace.id}
              data-active={isActive ? 'true' : undefined}
            >
              <div className="rail-workspace-head">
                {editing?.kind === 'workspace' &&
                editing.id === workspace.id ? (
                  editInput(editing, 'Space name')
                ) : (
                  <>
                    <button
                      type="button"
                      className="rail-workspace-name"
                      aria-expanded={isOpen}
                      aria-current={isActive ? 'true' : undefined}
                      title={workspace.name}
                      onClick={() => {
                        onSelectWorkspace(workspace.id);
                        toggle(workspace.id);
                      }}
                    >
                      <span
                        className="rail-workspace-chevron"
                        aria-hidden="true"
                      >
                        {isOpen ? '▾' : '▸'}
                      </span>
                      <span className="rail-workspace-label">
                        {workspace.name}
                      </span>
                    </button>
                    {/*
                      The space is named here rather than left to whichever one
                      is current: a chat started under this heading is filed
                      under it, even when the rail is pointed somewhere else.
                    */}
                    <button
                      type="button"
                      className="rail-workspace-action"
                      aria-label={`New chat in ${workspace.name}`}
                      disabled={disabled}
                      onClick={() => {
                        onNewSession(workspace.id);
                      }}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="rail-workspace-action rail-workspace-menu"
                      aria-haspopup="menu"
                      aria-expanded={
                        menu?.kind === 'workspace' &&
                        menu.workspaceId === workspace.id
                      }
                      aria-label={`Actions for ${workspace.name}`}
                      onClick={(event) => {
                        setMenu({
                          kind: 'workspace',
                          workspaceId: workspace.id,
                          anchor: anchorOf(event.currentTarget),
                        });
                      }}
                    >
                      ⋯
                    </button>
                  </>
                )}
              </div>
              <span className="rail-workspace-path" title={workspace.path}>
                {workspace.path}
              </span>
              {isOpen && sessionRows(group.sessions)}
            </section>
          );
        })}
      </nav>

      <KeepRunning />

      {menuSession !== undefined && menu !== null && (
        <SessionMenu
          session={menuSession}
          profileId={activeProfileId ?? ''}
          workspaces={workspaces}
          anchor={menu.anchor}
          onClose={() => {
            setMenu(null);
          }}
          onRename={() => {
            setMenu(null);
            beginEdit({
              kind: 'session',
              id: menuSession.id,
              value: menuSession.title,
            });
          }}
          onMove={(workspaceId) => {
            setMenu(null);
            onMoveSession(menuSession.id, workspaceId);
          }}
          onDelete={() => {
            setMenu(null);
            onDeleteSession(menuSession.id);
          }}
        />
      )}

      {menuWorkspace !== undefined && menu !== null && (
        <WorkspaceMenu
          workspace={menuWorkspace}
          anchor={menu.anchor}
          onClose={() => {
            setMenu(null);
          }}
          onRename={() => {
            setMenu(null);
            beginEdit({
              kind: 'workspace',
              id: menuWorkspace.id,
              value: menuWorkspace.name,
            });
          }}
          onOpen={() => {
            setMenu(null);
            onOpenWorkspace(menuWorkspace.id);
          }}
          onRemove={() => {
            setMenu(null);
            onRemoveWorkspace(menuWorkspace.id);
          }}
        />
      )}
    </aside>
  );
}

/** Time for today, a date before that. */
function shortDate(at: string): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) {
    return '';
  }
  const now = new Date();
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();

  return sameDay
    ? when.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})
    : when.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}
