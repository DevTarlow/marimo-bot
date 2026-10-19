/**
 * What one conversation's `…` offers.
 *
 * Four things, and the order is the order of how reversible they are: the id
 * (nothing changes), renaming (reversible), moving (reversible), deleting (not).
 * Deleting is asked twice, in place — the second press is the confirmation, so a
 * misfired click opens a question rather than ending a conversation.
 *
 * The id is the point of the whole menu for a bug report: it is what a job, a
 * Discord mention and an on-disk file all call this conversation, and unlike the
 * title nobody edits it.
 */
import {useEffect, useState} from 'react';

import type {SessionSummary, SessionUsage, Workspace} from '@marimo/protocol';

import {PopoverItem, Popover} from './Popover.js';
import type {PopoverAnchor} from './Popover.js';

export function SessionMenu({
  session,
  profileId,
  workspaces,
  anchor,
  onClose,
  onMove,
  onRename,
  onDelete,
}: {
  session: SessionSummary;
  profileId: string;
  workspaces: readonly Workspace[];
  anchor: PopoverAnchor;
  onClose: () => void;
  onMove: (workspaceId: string | null) => void;
  onRename: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [usage, setUsage] = useState<SessionUsage | 'loading' | 'error' | null>(
    null,
  );

  useEffect(() => {
    let live = true;
    setUsage('loading');
    void window.marimo
      .call('sessions.usage', {profileId, sessionId: session.id})
      .then((next) => {
        if (live) {
          setUsage(next);
        }
      })
      .catch(() => {
        if (live) {
          setUsage('error');
        }
      });
    return () => {
      live = false;
    };
  }, [profileId, session.id]);

  return (
    <Popover
      anchor={anchor}
      label={`Actions for ${session.title}`}
      onClose={onClose}
    >
      <div className="popover-id">
        <span className="popover-label">Session ID</span>
        <code>{session.id}</code>
        <button
          type="button"
          className="button button-quiet button-small"
          onClick={() => {
            void navigator.clipboard.writeText(session.id).then(
              () => {
                setCopied(true);
                setTimeout(() => {
                  setCopied(false);
                }, 1_500);
              },
              () => {
                // A clipboard the window cannot reach is not worth an error
                // banner; the id is on screen to select by hand.
              },
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="popover-id">
        <span className="popover-label">Usage</span>
        <span className="settings-muted">
          {usage === null || usage === 'loading'
            ? 'Reading…'
            : usage === 'error'
              ? 'Could not read this conversation’s usage.'
              : usage.engine === 'v1'
                ? 'v1 history — token usage is not recorded.'
                : `${usage.usage.totalTokens.toLocaleString()} tokens · ${usage.turns.toLocaleString()} turn${usage.turns === 1 ? '' : 's'}`}
        </span>
      </div>

      {confirming ? (
        <div className="popover-confirm">
          <p>
            Delete &ldquo;{session.title}&rdquo;? The conversation and its file
            are removed for good.
          </p>
          <div className="popover-row">
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger button-small"
              onClick={onDelete}
            >
              Delete
            </button>
          </div>
        </div>
      ) : (
        <>
          <PopoverItem onSelect={onRename}>Rename…</PopoverItem>
          <PopoverItem
            onSelect={() => {
              setConfirming(true);
            }}
            danger
          >
            Delete chat…
          </PopoverItem>
          <div className="popover-sep" />
          <span className="popover-label">Move to</span>
          {workspaces.map((workspace) => (
            <PopoverItem
              key={workspace.id}
              disabled={workspace.id === session.workspaceId}
              onSelect={() => {
                onMove(workspace.id);
              }}
            >
              {workspace.name}
            </PopoverItem>
          ))}
          {/*
            Always offered, and disabled for a conversation that is already
            unfiled — which is how the user finds out where it currently is
            rather than wondering why the entry does nothing.
          */}
          <PopoverItem
            disabled={session.workspaceId === undefined}
            onSelect={() => {
              onMove(null);
            }}
          >
            Other chats
          </PopoverItem>
        </>
      )}
    </Popover>
  );
}
