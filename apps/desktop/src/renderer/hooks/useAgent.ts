/**
 * The conversation, in the window.
 *
 * Three sources feed the transcript, and keeping them apart is the whole design:
 *
 * - **The stored transcript** is what was actually written down. It is read when
 *   a conversation is opened and again when a turn ends.
 * - **The live turn** is what is arriving right now, assembled from the event
 *   stream so the answer appears as it is written rather than after it is
 *   finished.
 * - **The outbox** is the user's own words between pressing send and the next
 *   transcript read. There is nothing else to draw them from: a send is an IPC
 *   round trip and then a turn that begins in the main process, and the
 *   conversation on disk is not re-read until that turn ends — so without this
 *   a sent message sat in no source at all, and the window looked as if it had
 *   swallowed it.
 *
 * At the end of every turn the live copy is thrown away and the stored one is
 * re-read. That is not belt-and-braces: a stream can be interrupted, an abort
 * keeps only what the provider finished, and a turn that failed halfway has text
 * on screen that was never persisted. Trusting the streamed copy would leave the
 * window showing an answer that does not exist in the conversation — and the
 * user's next message would be answered by a model that never saw it.
 *
 * Events are filtered by conversation. A turn running in another conversation
 * still broadcasts, and appending its deltas to the one on screen would
 * interleave two answers into one bubble.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import type {
  AgentModel,
  AgentProfile,
  ThemeMode,
  AgentUiEvent,
  PendingGate,
  SessionSummary,
  ToolCallRecord,
  TranscriptMessage,
  Workspace,
} from '@marimo/protocol';

import {folderForSession} from '../workspace-groups.js';
import {describe} from '../describe.js';

/*
 * A tool call in flight and a tool call read back from disk are the same shape,
 * and deliberately: `ToolCallRecord` is what the transcript stores, so a live
 * call that used a different type would need converting at exactly the moment
 * the two are swapped. `ok` being absent is what says "still running".
 */
export type LiveToolCall = ToolCallRecord;

/** The turn in flight, assembled from the stream. */
export interface LiveTurn {
  messageId: string;
  text: string;
  reasoning: string;
  toolCalls: LiveToolCall[];
  running: boolean;
}

/**
 * A helper agent's work, while it happens.
 *
 * Keyed by the parent's tool call, because that is what the window draws it in
 * place of: the turn is suspended inside `ask_agent`, so a thread *is* that call,
 * opened.
 *
 * The helper's own tool calls arrive on the same stream as the parent's — there
 * is one turn running — and are filed here rather than left in the turn's list.
 * A call that runs while a helper holds the turn belongs inside the helper's
 * group; left at the top level it would read as the parent's own work, which is
 * exactly what a group chat must not do.
 */
export interface Delegation {
  /**
   * The helper, as the events named it.
   *
   * The events' own record, kept whole: `agentId` is who it is and `name` is
   * what to draw, and the two are held together because a rename between the
   * event and the render is not the window's to reconcile.
   */
  agentId: string;
  name: string;
  task: string;
  text: string;
  /**
   * When the window saw it start.
   *
   * Only the fallback for a finish that arrives with no duration to show; the
   * engine's own `ms` is the measurement, because it is the process that timed
   * the work.
   */
  startedAt: number;
  /** The helper's calls, in the order they started. */
  toolCalls: LiveToolCall[];
  /** Set by `delegate.finished`; absent while the helper is still working. */
  done?: boolean;
  /** Whether it worked — absent until `done`. */
  ok?: boolean;
  /** How long the engine measured, in milliseconds. */
  ms?: number;
  error?: string;
}

export interface AgentController {
  ready: boolean;
  /** Why the window has nothing to show, when it has nothing to show. */
  error: string | null;
  profile: AgentProfile | undefined;
  /**
   * Every agent in the install, as `profiles.list` answered.
   *
   * The whole roster rather than the active one, because a window that can name
   * an `agentId` — a delegated message, a conversation's members — has to be able
   * to turn it into a name and an initial, and an id it cannot find has to be
   * drawn as something honest.
   */
  agents: AgentProfile[];
  sessions: SessionSummary[];
  sessionId: string | null;
  messages: TranscriptMessage[];
  /** Gates the open conversation is waiting on, stored or live. */
  pending: PendingGate[];
  live: LiveTurn | null;
  /**
   * Work the lead has handed to another agent, by the parent's tool call id.
   *
   * Emptied when the turn ends, however it ends. A thread that kept spinning
   * after its turn had failed or been stopped would be the window insisting on
   * work nothing is doing any more.
   */
  delegations: Record<string, Delegation>;
  /**
   * The user's own words, sent but not yet read back from the conversation.
   *
   * Drawn after the stored transcript and before the live turn, which is where
   * the message will be once the turn ends and the store is read again.
   */
  outbox: string | null;
  /**
   * A turn is in flight — including the moment between sending and the turn's
   * first event, when there is nothing to show yet but a message on its way.
   */
  busy: boolean;
  /**
   * Sends a message, and answers whether the turn was accepted.
   *
   * The answer is what lets the composer keep what was typed: a refusal — a
   * turn already running, an unknown conversation — is not a failure the user
   * should have to retype a prompt to recover from.
   *
   * `agentId` is the member the user addressed with `@`, when they addressed
   * one. The engine refuses an agent this conversation does not hold, so it is
   * passed through rather than checked here: who is a participant is a fact about
   * the stored conversation, and the window's copy of it is a copy.
   */
  send: (
    text: string,
    origin?: 'window' | 'pet',
    agentId?: string,
  ) => Promise<boolean>;
  decide: (callId: string, confirmed: boolean) => Promise<void>;
  stop: () => Promise<void>;
  /**
   * Records that an answer was wrong, and what was right instead.
   *
   * Takes the message rather than its id and text, because the turn it belongs
   * to is the part the caller cannot reconstruct: a correction that names only
   * the message cannot be read back onto the work the agent did, and the turn id
   * lives on the message the transcript already has.
   *
   * Answers whether it was stored, because the button that calls it says "Noted"
   * and a button that says that about something which was not recorded is worse
   * than one that did nothing.
   */
  noteCorrection: (
    message: TranscriptMessage,
    correction?: string,
  ) => Promise<boolean>;
  open: (sessionId: string) => Promise<void>;
  /**
   * Re-reads the open conversation.
   *
   * For the things that change it without a turn: a compaction appends an event
   * to the conversation on screen, and `session.changed` only re-lists the
   * sidebar. Trusting that to redraw the transcript would leave a window showing
   * the messages a summary has just replaced.
   */
  refresh: () => Promise<void>;
  /** Re-reads the agent and the conversation, after settings may have changed. */
  reload: () => Promise<void>;
  /**
   * Set when the tray has asked for Settings to open.
   *
   * A counter rather than a boolean: two presses in a row have to be two
   * different values, or the second one opens nothing.
   */
  openSettings: number;
  /** Suggestions that have arrived since the panel was last opened. */
  memoryWaiting: number;
  /** What the last background look at the conversation read, and found. */
  lastReview: {events: number; found: number} | null;
  /** Clears that, when the panel opens and the user is looking at them. */
  clearMemoryWaiting: () => void;
  /** The stored theme preference, kept in step with the settings file. */
  themeMode: ThemeMode;
  /**
   * Starts a conversation, in the space named or in the one the app picks.
   *
   * The name is what files it: a chat asked for under one space is started
   * there, not wherever the rail happens to be pointed.
   */
  newSession: (spaceId?: string) => Promise<void>;
  /**
   * Starts the conversation that makes a bot, and opens it.
   *
   * Answers a result rather than throwing: the setup flow has a screen to keep
   * up and a sentence to show when the lead cannot draft, and an exception
   * there would be a blank wizard.
   */
  startBotBuilder: () => Promise<{ok: boolean; problem?: string}>;
  /**
   * What the open conversation is for, when it is not an ordinary chat.
   *
   * Read off the session summary rather than kept as separate state: the
   * purpose is a stored fact about the conversation, and a reloaded window
   * reads it back from the same list the rail does.
   */
  sessionPurpose: SessionSummary['purpose'];
  /**
   * Switches to another bot, and lands on its newest conversation.
   *
   * The switch is the same `profiles.select` Settings uses; what this adds is
   * the reload. Conversations are scoped by profile, so the rail, the header and
   * the transcript are all wrong until the active bot's list is read again.
   */
  selectProfile: (profileId: string) => Promise<void>;
  dismissError: () => void;
  /** The spaces every agent works in, and which one is current. */
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /**
   * The directory of the space the open conversation works in, for the header.
   *
   * Not the same thing as the active workspace: a conversation remembers the
   * space it was started in, and the two differ the moment the user selects
   * another one.
   */
  activeFolder: string | null;
  /**
   * Loads a space.
   *
   * Answers the state the call itself produced rather than `void`: the setup
   * flow needs to know which space a chosen folder became, so it can land there,
   * and asking `workspaces.list` afterwards would be a second read of a fact the
   * write already returned. `added` is false when the picker was closed, which
   * is an answer rather than a failure.
   */
  loadWorkspace: () => Promise<{
    added: boolean;
    activeWorkspaceId: string | null;
  }>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  openWorkspace: (workspaceId: string) => Promise<void>;
  moveSession: (
    sessionId: string,
    workspaceId: string | null,
  ) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  /**
   * Points one conversation at a model of its own, or `null` to stop.
   *
   * The pair, never an id: the caller is the composer, whose list came from one
   * provider's catalogue, and a bare id would let a model from one endpoint be
   * stored against another.
   */
  setSessionModel: (
    sessionId: string,
    model: AgentModel | null,
  ) => Promise<void>;
  /**
   * Names the agents in a conversation, lead first.
   *
   * A group is something a chat grows into, so this is not a field of creating
   * one: the same call adds the second agent and puts the list back the way it
   * was. An empty list means "just the agent that owns it".
   */
  setParticipants: (sessionId: string, agentIds: string[]) => Promise<void>;
  /** Deletes a conversation, and lands somewhere sensible if it was open. */
  removeSession: (sessionId: string) => Promise<void>;
}

export function useAgent(): AgentController {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<AgentProfile | undefined>();
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [storedPending, setStoredPending] = useState<PendingGate[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [delegations, setDelegations] = useState<Record<string, Delegation>>({});
  const [outbox, setOutbox] = useState<string | null>(null);
  const [openSettings, setOpenSettings] = useState(0);
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  /**
   * How many suggestions have arrived since the user last looked at the panel.
   *
   * A count rather than the proposals themselves: this exists to put a dot
   * somewhere, and the panel already reads the real list from the store when it
   * opens. Held here because the event arrives while Settings is closed, which is
   * the whole reason the count is worth having — a suggestion nobody is told
   * about is one that only exists if they happen to reopen a dialog.
   */
  const [memoryWaiting, setMemoryWaiting] = useState(0);
  /**
   * What the last background look did.
   *
   * Kept apart from the count above and deliberately not cleared when the panel
   * opens: the count answers "is there something new", and this answers "is the
   * thing working at all" — a question a user asks precisely when a look has run
   * and proposed nothing, which is the answer most of the time.
   */
  const [lastReview, setLastReview] = useState<{events: number; found: number} | null>(
    null,
  );
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    null,
  );

  /*
   * Read by the event listener, which is registered once and would otherwise
   * close over the first render's values forever.
   */
  const openSession = useRef<string | null>(null);
  openSession.current = sessionId;

  /** Read inside the listener, for the same reason. */
  const profileRef = useRef<AgentProfile | undefined>(undefined);
  profileRef.current = profile;

  /**
   * The delegation the turn is currently inside, if any.
   *
   * A ref rather than a lookup in the state above, because the tool-call cases
   * need it synchronously: a helper's call can arrive in the same batch as the
   * `delegate.started` that opened it, and state read from a closure would still
   * be a render behind. There is at most one, because the turn that started it is
   * suspended until it finishes.
   */
  const helperAtWork = useRef<string | null>(null);

  const loadTranscript = useCallback(
    async (profileId: string, id: string): Promise<void> => {
      const result = await window.marimo.call('sessions.get', {
        profileId,
        sessionId: id,
      });
      // The conversation may have been switched while this was in flight, and
      // committing it then would put one conversation's history under another's
      // title.
      if (openSession.current !== id) {
        return;
      }
      setMessages(result.messages);
      setStoredPending(result.pending);
      /*
       * The stored copy is here, so the echo has nothing left to stand in for.
       * Cleared in the same batch as the messages it replaces, because the two
       * are the same bubble: a frame apart would blink it.
       */
      setOutbox(null);
    },
    [],
  );

  const open = useCallback(
    async (id: string): Promise<void> => {
      setSessionId(id);
      setLive(null);
      setDelegations({});
      helperAtWork.current = null;
      setStoredPending([]);
      setMessages([]);
      setOutbox(null);
      if (profile) {
        await loadTranscript(profile.id, id);
      }
    },
    [profile, loadTranscript],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const id = openSession.current;
    if (profile === undefined || id === null) {
      return;
    }
    try {
      /*
       * No clearing of the live turn or the echo first: nothing about a refresh
       * says a turn is over, and blanking the screen to reload it would blink
       * over something the user is reading. `loadTranscript` replaces the
       * messages and drops the echo in one batch, which is the same swap the end
       * of a turn makes.
       */
      await loadTranscript(profile.id, id);
    } catch (failure) {
      setError(describe(failure));
    }
  }, [profile, loadTranscript]);

  /**
   * Adopts a whole space list.
   *
   * Whole rather than merged: every call that changes one answers with the list
   * and the current space together, and a window that merged a single entry
   * into its own copy could disagree with the file about the order, or about
   * which space is current.
   */
  const applyWorkspaceState = useCallback(
    (state: {workspaces: Workspace[]; activeWorkspaceId: string | null}): void => {
      setWorkspaces(state.workspaces);
      setActiveWorkspaceId(state.activeWorkspaceId);
    },
    [],
  );

  const loadWorkspace = useCallback(async (): Promise<{
    added: boolean;
    activeWorkspaceId: string | null;
  }> => {
    try {
      const state = await window.marimo.call('workspaces.add', {});
      applyWorkspaceState(state);
      // Cancelling a dialog is an answer, not a failure: nothing is red.
      return {added: state.added, activeWorkspaceId: state.activeWorkspaceId};
    } catch (failure) {
      setError(describe(failure));
      return {added: false, activeWorkspaceId: null};
    }
  }, [applyWorkspaceState]);

  const selectWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      try {
        applyWorkspaceState(
          await window.marimo.call('workspaces.select', {workspaceId}),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [applyWorkspaceState],
  );

  const renameWorkspace = useCallback(
    async (workspaceId: string, name: string): Promise<void> => {
      try {
        applyWorkspaceState(
          await window.marimo.call('workspaces.rename', {workspaceId, name}),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [applyWorkspaceState],
  );

  /**
   * Forgets a space.
   *
   * The conversations filed under it are not touched and do not need reloading:
   * their `workspaceId` now names nothing, which is what the rail draws as
   * "Other chats" — and the header follows, because the space it was showing is
   * gone.
   */
  const removeWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      try {
        applyWorkspaceState(
          await window.marimo.call('workspaces.remove', {workspaceId}),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [applyWorkspaceState],
  );

  const openWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      try {
        const {opened} = await window.marimo.call('workspaces.open', {
          workspaceId,
        });
        if (!opened) {
          setError('Could not open the space in your file manager.');
        }
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [],
  );

  const boot = useCallback(async (): Promise<void> => {
    try {
      const listed = await window.marimo.call('profiles.list', {});
      const active =
        listed.profiles.find(
          (entry) => entry.id === listed.activeProfileId,
        ) ?? listed.profiles[0];
      setProfile(active);
      // The roster, not just the active agent: a group chat is drawn with names
      // this window has to look up by id, including agents that are not talking.
      setAgents(listed.profiles);

      if (active === undefined) {
        setError('This install has no bot. Reopen the app to create one.');
        setReady(true);
        return;
      }

      /*
       * The spaces, before the conversations: the rail draws every conversation
       * inside one, and a list that arrived a frame later would put them all
       * under "Other chats" and then move them.
       */
      applyWorkspaceState(await window.marimo.call('workspaces.list', {}));

      const {sessions: existing} = await window.marimo.call('sessions.list', {
        profileId: active.id,
      });
      setSessions(existing);

      /*
       * Land on the newest conversation, or make one. A window that opens on
       * nothing makes the user hunt for the button before they can type, and the
       * first thing anybody does with an empty app is start talking to it.
       */
      if (existing.length > 0 && existing[0] !== undefined) {
        setSessionId(existing[0].id);
        await loadTranscript(active.id, existing[0].id);
      } else {
        const {session} = await window.marimo.call('sessions.create', {
          profileId: active.id,
        });
        setSessions([session]);
        setSessionId(session.id);
      }
      setReady(true);
    } catch (failure) {
      const detail = describe(failure);
      console.error('[marimo] the window could not start:', detail);
      setError(detail);
      setReady(true);
    }
  }, [loadTranscript, applyWorkspaceState]);

  /**
   * Switches bots, then reloads everything that is scoped to the active one.
   *
   * Deliberately does not abort a running turn. A turn belongs to the
   * conversation it is in, not to the window looking at it, and a switch that
   * killed an answer somebody asked for would make the rail's most ordinary
   * control destructive.
   */
  const selectProfile = useCallback(
    async (profileId: string): Promise<void> => {
      if (profile?.id === profileId) {
        return;
      }
      try {
        await window.marimo.call('profiles.select', {profileId});
        /*
         * The live turn belongs to the conversation of the bot being left.
         * Clearing before the reload matters because `boot` only reads the
         * stored transcript; without this, a delta or an outbox from the old
         * conversation would be drawn in the new one for as long as the read
         * takes.
         */
        setLive(null);
        setDelegations({});
        helperAtWork.current = null;
        setOutbox(null);
        setStoredPending([]);
        setMessages([]);
        setSessionId(null);
        await boot();
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile, boot],
  );

  /* The stream. Registered once; everything it needs is read from refs. */
  useEffect(() => {
    const off = window.marimo.onEvent((event: AgentUiEvent) => {
      /*
       * Not every event belongs to a conversation. An MCP server connecting, the
       * agent profile changing, the skills list changing: those carry no session
       * id at all and are drawn by whatever owns them. This listener is only the
       * conversation, so it stops here rather than guessing at a session.
       */
      /*
       * The tray asking for Settings, which is the one message that is not about
       * a conversation. Handled before the filter below, because it has no
       * session to be filtered by.
       */
      if (event.type === 'window.openSettings') {
        setOpenSettings((count) => count + 1);
        return;
      }

      /*
       * The preference, which changes without this window asking — so it arrives
       * as an event rather than being something the window only notices when it
       * reloads.
       */
      if (event.type === 'theme.changed') {
        setThemeMode(event.mode);
        return;
      }

      /*
       * A background look at the conversation found something worth remembering.
       *
       * Handled before the conversation filter because a proposal belongs to the
       * *agent* rather than to whichever chat is on screen, and the event carries
       * no session id to be filtered by. Counted rather than replaced, because
       * two looks since the user last opened the panel are two more suggestions
       * waiting, not the latest one.
       */
      if (event.type === 'memory.proposed') {
        setMemoryWaiting((count) => count + event.count);
        return;
      }
      if (event.type === 'memory.reviewed') {
        setLastReview({events: event.events, found: event.found});
        return;
      }

      if (!('sessionId' in event)) {
        return;
      }
      const forUs = event.sessionId === openSession.current;

      switch (event.type) {
        case 'turn.started':
          if (forUs) {
            setLive({
              messageId: event.messageId,
              text: '',
              reasoning: '',
              toolCalls: [],
              running: true,
            });
          }
          return;

        case 'text.delta':
          if (forUs) {
            setLive((turn) =>
              turn === null
                ? turn
                : {...turn, text: turn.text + event.text},
            );
          }
          return;

        case 'reasoning.delta':
          if (forUs) {
            setLive((turn) =>
              turn === null
                ? turn
                : {...turn, reasoning: turn.reasoning + event.text},
            );
          }
          return;

        case 'tool.started':
          if (forUs) {
            /*
             * A call that starts while a helper holds the turn is the helper's,
             * not the lead's: the lead is suspended inside `ask_agent` and cannot
             * be calling anything. Filed under the thread so it is drawn inside
             * it, where the work it belongs to is.
             */
            if (helperAtWork.current !== null) {
              const helper = helperAtWork.current;
              setDelegations((current) => {
                const work = current[helper];
                return work === undefined
                  ? current
                  : {
                      ...current,
                      [helper]: {
                        ...work,
                        toolCalls: [
                          ...work.toolCalls,
                          {callId: event.callId, tool: event.tool, args: event.args},
                        ],
                      },
                    };
              });
              return;
            }
            setLive((turn) =>
              turn === null
                ? turn
                : {
                    ...turn,
                    toolCalls: [
                      ...turn.toolCalls,
                      {callId: event.callId, tool: event.tool, args: event.args},
                    ],
                  },
            );
          }
          return;

        case 'tool.finished':
          if (forUs) {
            if (helperAtWork.current !== null) {
              const helper = helperAtWork.current;
              setDelegations((current) => {
                const work = current[helper];
                return work === undefined
                  ? current
                  : {
                      ...current,
                      [helper]: {
                        ...work,
                        toolCalls: work.toolCalls.map((call) =>
                          call.callId === event.callId
                            ? {...call, ok: event.ok, result: event.result}
                            : call,
                        ),
                      },
                    };
              });
              return;
            }
            setLive((turn) =>
              turn === null
                ? turn
                : {
                    ...turn,
                    toolCalls: turn.toolCalls.map((call) =>
                      call.callId === event.callId
                        ? {...call, ok: event.ok, result: event.result}
                        : call,
                    ),
                  },
            );
          }
          return;

        case 'delegate.started':
          if (forUs) {
            helperAtWork.current = event.callId;
            setDelegations((current) => ({
              ...current,
              [event.callId]: {
                agentId: event.agentId,
                name: event.name,
                task: event.task,
                text: '',
                startedAt: Date.now(),
                toolCalls: [],
              },
            }));
          }
          return;

        case 'delegate.event':
          if (forUs) {
            setDelegations((current) => {
              const work = current[event.callId];
              /*
               * Dropped when there is no thread to put it in. That is not a
               * hypothetical: a delta can land after the turn ended and the map
               * was emptied, and a thread conjured from a delta alone would have
               * no agent and no task — a header naming nobody.
               */
              return work === undefined
                ? current
                : {
                    ...current,
                    [event.callId]: {...work, text: work.text + event.text},
                  };
            });
          }
          return;

        case 'delegate.finished':
          if (forUs) {
            if (helperAtWork.current === event.callId) {
              helperAtWork.current = null;
            }
            setDelegations((current) => {
              const work = current[event.callId];
              return work === undefined
                ? current
                : {
                    ...current,
                    [event.callId]: {
                      ...work,
                      done: true,
                      ok: event.ok,
                      ms: event.ms,
                      ...(event.error === undefined ? {} : {error: event.error}),
                    },
                  };
            });
          }
          return;

        case 'approval.request':
          if (forUs) {
            setStoredPending((pending) =>
              pending.some((gate) => gate.callId === event.callId)
                ? pending
                : [
                    ...pending,
                    {
                      callId: event.callId,
                      tool: event.tool,
                      args: event.args,
                      hint: event.hint,
                      askedAt: new Date().toISOString(),
                    },
                  ],
            );
          }
          return;

        case 'turn.completed':
        case 'turn.aborted':
        case 'turn.failed': {
          if (event.type === 'turn.failed' && event.message.length > 0) {
            setError(event.message);
          }
          /*
           * The stored transcript wins from here. Dropping the live copy and
           * re-reading is what keeps what is on screen equal to what is in the
           * conversation — including after an abort, where only what the
           * provider finished was ever written.
           */
          const id = openSession.current;
          const active = profileRef.current;
          if (forUs) {
            /*
             * The helpers go with the turn, whatever ended it. A thread is only
             * ever a claim that work is happening; after an abort or a failure
             * nothing is, and a group left open would be the window insisting
             * otherwise for as long as it stays on screen. The calls survive in
             * the stored transcript, which is read again below.
             */
            setLive(null);
            setDelegations({});
            helperAtWork.current = null;
            if (id !== null && active !== undefined) {
              void loadTranscript(active.id, id).catch(() => undefined);
            }
          }
          return;
        }

        case 'session.changed': {
          const active = profileRef.current;
          if (active === undefined) {
            return;
          }
          void window.marimo
            .call('sessions.list', {profileId: active.id})
            .then(({sessions: next}) => {
              setSessions(next);
            })
            .catch(() => undefined);
          return;
        }

        default:
          return;
      }
    });

    return off;
  }, [loadTranscript]);

  useEffect(() => {
    void boot();
    // Once, on mount: this is the window's first look at the install, and
    // re-running it whenever a callback identity changed would re-open a
    // conversation under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noteCorrection = useCallback(
    async (
      message: TranscriptMessage,
      correction?: string,
    ): Promise<boolean> => {
      const sessionId = openSession.current;
      if (sessionId === null) {
        return false;
      }
      try {
        const result = await window.marimo.call('memory.feedback', {
          sessionId,
          messageId: message.id,
          /*
           * The turn, when the message has one. Sent rather than derived later
           * because the window is the only place that has it: the feedback
           * document outlives every surface that could reconstruct it, and a
           * mark that cannot be joined to the recorded work is a note about
           * prose rather than a fact about a turn.
           */
          ...(message.invocationId === undefined
            ? {}
            : {invocationId: message.invocationId}),
          // Capped here as well as in the schema: the answer can be arbitrarily
          // long and only the opening of it is needed to recognise it later.
          excerpt: message.text.slice(0, 400),
          ...(correction === undefined || correction.trim().length === 0
            ? {}
            : {correction: correction.trim().slice(0, 400)}),
        });
        if (!result.ok) {
          setError(result.problem ?? 'That could not be recorded.');
          return false;
        }
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
    },
    [],
  );

  const send = useCallback(
    async (
      text: string,
      origin: 'window' | 'pet' = 'window',
      agentId?: string,
    ): Promise<boolean> => {
      if (profile === undefined || sessionId === null) {
        return false;
      }
      setError(null);
      /*
       * Drawn before the round trip rather than after it. The words are the one
       * thing the window already has, and a send that shows nothing until a turn
       * starts in another process reads as a message that did not go.
       */
      setOutbox(text);
      try {
        const {accepted} = await window.marimo.call('chat.send', {
          profileId: profile.id,
          sessionId,
          text,
          /*
           * Which surface asked. Stated rather than left to the default, so a
           * caller cannot end up looking like another by omission.
           */
          origin,
          // Absent rather than `undefined`: the schema has the field optional,
          // and the lead is what answers when nobody was named.
          ...(agentId === undefined ? {} : {agentId}),
        });
        /*
         * Refused — a turn already running, an unknown conversation. The refusal
         * arrives as `turn.failed` and is drawn where every other failure is;
         * the echo goes with it, because a message that was never stored is not
         * one to leave on screen as if it had been.
         */
        if (!accepted) {
          setOutbox(null);
          return false;
        }
        return true;
      } catch (failure) {
        setOutbox(null);
        setError(describe(failure));
        return false;
      }
    },
    [profile, sessionId],
  );

  const decide = useCallback(
    async (callId: string, confirmed: boolean): Promise<void> => {
      if (profile === undefined || sessionId === null) {
        return;
      }
      // Taken down straight away rather than after the round trip: the button
      // has been pressed, and a card that stays put invites a second press.
      setStoredPending((pending) =>
        pending.filter((gate) => gate.callId !== callId),
      );
      try {
        await window.marimo.call('chat.approve', {
          profileId: profile.id,
          sessionId,
          callId,
          confirmed,
        });
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile, sessionId],
  );

  const stop = useCallback(async (): Promise<void> => {
    if (profile === undefined || sessionId === null) {
      return;
    }
    try {
      await window.marimo.call('chat.abort', {
        profileId: profile.id,
        sessionId,
      });
    } catch (failure) {
      setError(describe(failure));
    }
  }, [profile, sessionId]);

  /**
   * Starts a conversation, in the space named or in the current one.
   *
   * Named *and* selected, because the two do different jobs. The name is what
   * files the chat: the runtime puts it in the space it was given — the named
   * one, else this agent's default, else the active one — so a chat started
   * under "website repo" lands there even when the rail is somewhere else. The
   * selection is what the rail draws: without it the space marked current would
   * be one the conversation on screen is not in, which is the thing a highlight
   * is for.
   */
  const newSession = useCallback(
    async (spaceId?: string): Promise<void> => {
      if (profile === undefined) {
        return;
      }
      try {
        if (spaceId !== undefined && spaceId !== activeWorkspaceId) {
          await selectWorkspace(spaceId);
        }
        const {session} = await window.marimo.call('sessions.create', {
          profileId: profile.id,
          ...(spaceId === undefined ? {} : {spaceId}),
        });
        setSessions((current) => [session, ...current]);
        setSessionId(session.id);
        setMessages([]);
        setStoredPending([]);
        setLive(null);
        setDelegations({});
        helperAtWork.current = null;
        setOutbox(null);
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile, activeWorkspaceId, selectWorkspace],
  );

  /**
   * Opens the bot-builder conversation.
   *
   * The same state swap `newSession` makes, because it is the same kind of
   * conversation; the difference is the stored purpose, which the runtime writes
   * and every later turn reads. Nothing is sent here — the opening question is a
   * card the transcript draws from the purpose.
   */
  const startBotBuilder = useCallback(async (): Promise<{
    ok: boolean;
    problem?: string;
  }> => {
    if (profile === undefined) {
      return {ok: false, problem: 'There is no bot to start this conversation.'};
    }
    try {
      const {session} = await window.marimo.call('sessions.startBuilder', {
        profileId: profile.id,
      });
      setSessions((current) => [session, ...current]);
      setSessionId(session.id);
      setMessages([]);
      setStoredPending([]);
      setLive(null);
      setDelegations({});
      helperAtWork.current = null;
      setOutbox(null);
      return {ok: true};
    } catch (failure) {
      const problem = describe(failure);
      setError(problem);
      return {ok: false, problem};
    }
  }, [profile]);

  /*
   * Filing and naming replace the one entry rather than reloading the list.
   * Neither is activity, so the store leaves `updatedAt` alone — and a reload
   * would only re-derive the order the rail already has.
   */
  const moveSession = useCallback(
    async (sessionId: string, workspaceId: string | null): Promise<void> => {
      if (profile === undefined) {
        return;
      }
      try {
        const {session} = await window.marimo.call('sessions.move', {
          profileId: profile.id,
          sessionId,
          workspaceId,
        });
        setSessions((current) =>
          current.map((entry) => (entry.id === session.id ? session : entry)),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string): Promise<void> => {
      if (profile === undefined) {
        return;
      }
      try {
        const {session} = await window.marimo.call('sessions.rename', {
          profileId: profile.id,
          sessionId,
          title,
        });
        setSessions((current) =>
          current.map((entry) => (entry.id === session.id ? session : entry)),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile],
  );

  const setSessionModel = useCallback(
    async (sessionId: string, model: AgentModel | null): Promise<void> => {
      if (profile === undefined) {
        return;
      }
      try {
        const {session} = await window.marimo.call('sessions.setModel', {
          profileId: profile.id,
          sessionId,
          model,
        });
        /*
         * The answer is the stored entry, not the value that was asked for: a
         * cleared choice comes back with no `model` at all, and the composer
         * reads that absence as "following the agent" rather than as a model id
         * it should keep showing.
         */
        setSessions((current) =>
          current.map((entry) => (entry.id === session.id ? session : entry)),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile],
  );

  /**
   * Names the agents in a conversation, lead first.
   *
   * The answer is the stored entry, like every other session write here: who is
   * in a conversation is the file's fact, and the window's list is redrawn from
   * what came back rather than from the ids it asked for — the store may keep
   * them in the order it was given, or refuse one.
   */
  const setParticipants = useCallback(
    async (sessionId: string, agentIds: string[]): Promise<void> => {
      if (profile === undefined) {
        return;
      }
      try {
        const {session} = await window.marimo.call('sessions.setParticipants', {
          profileId: profile.id,
          sessionId,
          agentIds,
        });
        setSessions((current) =>
          current.map((entry) => (entry.id === session.id ? session : entry)),
        );
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile],
  );

  /**
   * Deletes a conversation, and lands somewhere sensible.
   *
   * The list is re-read rather than filtered locally, because the question the
   * fallback answers is "what is left, newest first" — and the copy this window
   * holds is not the authority on that the moment anything else has written.
   * Deleting the last conversation starts a fresh one, which is what the window
   * opened with.
   */
  const removeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (profile === undefined) {
        return;
      }
      try {
        await window.marimo.call('sessions.delete', {profileId: profile.id, sessionId});
        const {sessions: remaining} = await window.marimo.call('sessions.list', {
          profileId: profile.id,
        });
        setSessions(remaining);
        if (sessionId !== openSession.current) {
          return;
        }
        const next = remaining[0];
        setMessages([]);
        setStoredPending([]);
        setLive(null);
        setDelegations({});
        helperAtWork.current = null;
        setOutbox(null);
        if (next === undefined) {
          await newSession();
          return;
        }
        setSessionId(next.id);
        await loadTranscript(profile.id, next.id);
      } catch (failure) {
        setError(describe(failure));
      }
    },
    [profile, loadTranscript, newSession],
  );

  const pending = useMemo(() => storedPending, [storedPending]);

  const activeFolder = useMemo(
    () =>
      folderForSession({
        workspaces,
        sessions,
        sessionId,
        activeWorkspaceId,
      }),
    [workspaces, sessions, sessionId, activeWorkspaceId],
  );

  /*
   * Waiting, from the moment the message is sent. `live` alone would leave the
   * gap between the send and the turn's first event unaccounted for, which is
   * the one moment the user is certain something should be happening.
   */
  const busy = live?.running === true || outbox !== null;

  /*
   * Derived from the stored summary rather than held as a flag: a window that
   * reloads must draw the builder's opening card from the conversation it
   * opened, not from a piece of state that belonged to the previous render.
   */
  const sessionPurpose = sessions.find(
    (entry) => entry.id === sessionId,
  )?.purpose;

  return {
    ready,
    error,
    profile,
    agents,
    sessions,
    sessionId,
    messages,
    pending,
    live,
    delegations,
    outbox,
    busy,
    send,
    decide,
    stop,
    noteCorrection,
    open,
    refresh,
    openSettings,
    themeMode,
    memoryWaiting,
    lastReview,
    clearMemoryWaiting: () => {
      setMemoryWaiting(0);
    },
    reload: boot,
    newSession,
    startBotBuilder,
    sessionPurpose,
    selectProfile,
    dismissError: () => {
      setError(null);
    },
    workspaces,
    activeWorkspaceId,
    activeFolder,
    loadWorkspace,
    selectWorkspace,
    renameWorkspace,
    removeWorkspace,
    openWorkspace,
    moveSession,
    renameSession,
    setSessionModel,
    setParticipants,
    removeSession,
  };
}
