/**
 * The review card a `draft_bot` call becomes.
 *
 * This is the only path from a conversation to a bot, and that is the point: the
 * model proposed, the person reads and edits, and *they* press Create. The card
 * is drawn from the tool call's own arguments rather than from a second store,
 * so a reloaded conversation shows the same draft with the same call id — which
 * is also what lets it tell that it already made this bot.
 *
 * The Role is shown but not edited here. It is the app's brief; Settings has the
 * editor and the Reset, and a person deciding whether a bot is right should not
 * be handed a system prompt to rewrite in a chat.
 */
import {useEffect, useState} from 'react';

import {DEFAULT_BOT_PERSONA} from '@marimo/protocol';
import type {AgentProfile, BotDraft} from '@marimo/protocol';

import {
  abilityLines,
  createdFrom,
  draftRole,
  parseBotDraft,
  resolveBotDraft,
} from '../bot-draft.js';
import type {ResolvedBotDraft} from '../bot-draft.js';
import {describe} from '../describe.js';
import {useProfileCatalog} from '../hooks/useProfileCatalog.js';

export interface BotDraftCall {
  callId: string;
  tool: string;
  args: unknown;
  result?: string;
  ok?: boolean;
}

export function BotDraftCard({
  call,
  profiles,
  leadId,
  onBotCreated,
}: {
  call: BotDraftCall;
  /** Every profile, so the card can tell whether this call already made one. */
  profiles: readonly AgentProfile[];
  /** The lead, restored after the create switches the active profile. */
  leadId: string | undefined;
  /** The app's settings refresh, after the roster has changed. */
  onBotCreated?: (next: {
    profiles: AgentProfile[];
    activeProfileId: string;
    created: AgentProfile;
  }) => void;
}): React.JSX.Element | null {
  const catalog = useProfileCatalog();
  const parsed = parseBotDraft(call.args);
  const [draft, setDraft] = useState<ResolvedBotDraft | null>(null);
  const [delegate, setDelegate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  /*
   * The receipt the create itself leaves. The roster is the durable answer —
   * `createdFromCall` survives a reload — but a card that waited for the
   * window's settings copy to come back would keep offering the button for the
   * length of that round trip, and a second press in that gap is a second bot.
   */
  const [made, setMade] = useState<AgentProfile | null>(null);
  const existing = made ?? createdFrom(profiles, call.callId);

  /*
   * Seeded once the catalogue has landed. The catalogue is what turns a template
   * id into a Persona and a grant, and a card that guessed before it arrived
   * would show the user defaults it was about to replace.
   */
  useEffect(() => {
    if (draft !== null || parsed === undefined || catalog === null) {
      return;
    }
    setDraft(resolveBotDraft(parsed, catalog.botTemplates));
  }, [parsed, catalog, draft]);

  if (hidden) {
    return null;
  }

  if (parsed === undefined) {
    return (
      <div className="bot-draft bot-draft-problem">
        <p>
          Marimo sent a draft that could not be read. Ask it to try again with a
          name and what the bot is for.
        </p>
        {call.result !== undefined && <pre>{call.result}</pre>}
      </div>
    );
  }

  if (existing !== undefined) {
    return (
      <div className="bot-draft bot-draft-created">
        <p>
          <strong>{existing.name}</strong> was made from this draft. It is in
          the rail whenever you want to talk to it.
        </p>
        {/* Something after the create — the delegation grant or the way back to
            the lead — can still fail, and the bot existing does not make that
            succeed. */}
        {problem !== null && <p className="settings-problem">{problem}</p>}
      </div>
    );
  }

  if (draft === null) {
    return (
      <div className="bot-draft">
        <p className="settings-muted">Reading the draft…</p>
      </div>
    );
  }

  const templates = catalog?.botTemplates ?? [];
  const template = templates.find((entry) => entry.id === draft.templateId);
  const templateSeed = template?.persona ?? DEFAULT_BOT_PERSONA;
  const lead = profiles.find((entry) => entry.id === leadId);
  const delegationTool = catalog?.delegationTool;
  const alreadyDelegates =
    delegationTool !== undefined &&
    (lead?.enabledTools.includes(delegationTool) ?? false);

  const changeTemplate = (id: string | undefined): void => {
    if (catalog === null) {
      return;
    }
    setDraft((current) => {
      if (current === null) {
        return resolveBotDraft({templateId: id}, catalog.botTemplates);
      }
      /*
       * The new role's defaults, not the model's original draft: the persona it
       * wrote for a Writer is not the persona a Coder should start with. A
       * Persona the person has changed is theirs, so a template change re-seeds
       * only text still equal to the old seed. The abilities follow the role,
       * because a Writer's grant is not a Coder's; the name stays theirs.
       */
      const next = resolveBotDraft(
        {name: current.name, templateId: id},
        catalog.botTemplates,
      );
      const personaIsSeed =
        current.persona.trim().length === 0 || current.persona === templateSeed;
      return {
        ...next,
        ...(personaIsSeed ? {} : {persona: current.persona}),
      };
    });
  };

  const create = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const payload: BotDraft = {
        ...(draft.name.trim().length === 0 ? {} : {name: draft.name.trim()}),
        ...(draft.templateId === undefined
          ? {}
          : {templateId: draft.templateId}),
        // Sent even when empty: a cleared box is the person saying no, and the
        // runtime's seed is for a caller that decided nothing.
        persona: draft.persona,
        tools: draft.tools,
        ...(draft.avatar === undefined ? {} : {avatar: draft.avatar}),
      };
      const created = await window.marimo.call('profiles.create', {
        draft: payload,
        sourceCallId: call.callId,
      });
      /*
       * The receipt goes up before the two calls that follow, because the bot
       * exists from this moment: a delegation patch that fails must not leave
       * the card offering to make it again.
       */
      setMade(created.created);
      if (
        delegate &&
        delegationTool !== undefined &&
        lead !== undefined &&
        !lead.enabledTools.includes(delegationTool)
      ) {
        await window.marimo.call('profiles.update', {
          profileId: lead.id,
          patch: {enabledTools: [...lead.enabledTools, delegationTool]},
        });
      }
      /*
       * Back to the lead: `profiles.create` switches to the new bot, and the
       * conversation that asked for it belongs to the one that was talking.
       */
      if (leadId !== undefined) {
        const back = await window.marimo.call('profiles.select', {
          profileId: leadId,
        });
        onBotCreated?.({...back, created: created.created});
      } else {
        onBotCreated?.(created);
      }
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const abilities = abilityLines(draft, catalog);
  const role = draftRole(draft, templates);

  return (
    <div className="bot-draft">
      <div className="bot-draft-head">
        <span className="bot-draft-tag">A bot to review</span>
        <span className="bot-draft-name">{draft.name || 'Untitled bot'}</span>
      </div>

      <label className="settings-field">
        <span>Name</span>
        <input
          className="settings-input"
          type="text"
          value={draft.name}
          disabled={busy}
          spellCheck={false}
          onChange={(event) => {
            setDraft({...draft, name: event.target.value});
          }}
        />
      </label>

      <label className="settings-field">
        <span>Starter role</span>
        <select
          className="settings-input"
          value={draft.templateId ?? ''}
          disabled={busy}
          onChange={(event) => {
            changeTemplate(
              event.target.value.length === 0 ? undefined : event.target.value,
            );
          }}
        >
          <option value="">Start from scratch</option>
          {templates.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span>Persona</span>
        <em className="settings-why">
          What it is for, how it should sound, and how you want to be spoken to.
        </em>
        <textarea
          className="settings-input settings-preferences"
          rows={7}
          value={draft.persona}
          disabled={busy}
          onChange={(event) => {
            setDraft({...draft, persona: event.target.value});
          }}
        />
      </label>

      {abilities.length > 0 && (
        <details className="bot-draft-abilities">
          <summary>What it can do ({abilities.length})</summary>
          <ul>
            {abilities.map((ability) => (
              <li key={ability.name}>
                <strong>{ability.name}</strong> — {ability.blurb}
              </li>
            ))}
          </ul>
        </details>
      )}

      <details className="bot-draft-role">
        <summary>What it is for (the Role)</summary>
        <pre>{role}</pre>
      </details>

      {delegationTool !== undefined && (
        <label className="settings-check">
          <input
            type="checkbox"
            checked={alreadyDelegates || delegate}
            disabled={busy || alreadyDelegates}
            onChange={(event) => {
              setDelegate(event.target.checked);
            }}
          />
          <span>
            Let Marimo Bot hand work to it
            <em className="settings-why">
              {alreadyDelegates
                ? 'Marimo Bot can already do this.'
                : 'Without it, Marimo Bot can talk about this bot but cannot ask it to do anything.'}
            </em>
          </span>
        </label>
      )}

      {problem !== null && <p className="settings-problem">{problem}</p>}

      <div className="onboarding-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={busy || draft.name.trim().length === 0}
          onClick={() => {
            void create();
          }}
        >
          {busy
            ? `Making ${draft.name.trim() || 'this bot'}…`
            : `Create ${draft.name.trim() || 'this bot'}`}
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={busy}
          onClick={() => {
            setHidden(true);
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
