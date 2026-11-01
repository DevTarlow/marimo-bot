/**
 * The two forms that make a bot by asking, rather than by talking.
 *
 * Both write the same `BotDraft` to `profiles.create`, so the store and the
 * prompt cannot tell which door somebody came through. The starter-role form
 * asks only for a name and whether Marimo Bot may hand the bot work; the
 * step-by-step form adds the role picker and the capability cards for somebody
 * who wants a custom bot.
 *
 * They live here rather than inside `Setup.tsx` because the setup is now a step
 * machine: the orchestrator decides whether the bot step exists and what the
 * suggested role is, and these forms are what that step renders. The
 * `recommendedId` is a suggestion drawn from the goals, never a preselected
 * grant — the person can choose any card.
 */
import {useState} from 'react';

import type {
  AgentProfile,
  BotDraft,
  BotTemplate,
  CapabilityPreset,
} from '@marimo/protocol';

import {chosenPreset} from '../capabilities.js';
import {BotTemplatePicker} from './BotTemplatePicker.js';

/**
 * The starter-role form: pick a card, name it, make it.
 *
 * The template decides the Role, the seeded Persona, the tools and the avatar;
 * the only thing this form asks for is the name and whether Marimo Bot may hand
 * it work. The Persona step after it is where the person changes the character,
 * because that is a decision about a bot that exists rather than a draft.
 */
export function TemplateBotForm({
  templates,
  selectedId,
  recommendedId,
  busy,
  delegateTool,
  lead,
  onSelect,
  onSubmit,
  onBack,
}: {
  templates: readonly BotTemplate[];
  selectedId: string | undefined;
  recommendedId: string | undefined;
  busy: boolean;
  delegateTool: string | undefined;
  lead: AgentProfile | undefined;
  onSelect: (id: string | undefined) => void;
  onSubmit: (draft: BotDraft, delegate: boolean) => Promise<void>;
  onBack: () => void;
}): React.JSX.Element {
  const selected = templates.find((template) => template.id === selectedId);
  const [name, setName] = useState(selected?.suggestedName ?? '');
  const [delegate, setDelegate] = useState(true);
  const alreadyDelegates =
    delegateTool !== undefined &&
    (lead?.enabledTools.includes(delegateTool) ?? false);

  return (
    <>
      <p className="onboarding-lead">
        Pick the role closest to the job. Its Role and Persona are a starting
        point you can change.
      </p>
      <BotTemplatePicker
        templates={templates}
        selectedId={selectedId}
        recommendedId={recommendedId}
        busy={busy}
        allowCustom={false}
        onSelect={(id) => {
          onSelect(id);
          const template = templates.find((entry) => entry.id === id);
          if (template !== undefined) {
            setName(template.suggestedName);
          }
        }}
      />
      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (trimmed.length === 0 || busy || selected === undefined) {
            return;
          }
          void onSubmit({name: trimmed, templateId: selected.id}, delegate);
        }}
      >
        <label className="settings-field">
          <span>Name</span>
          <em className="settings-why">
            Name it after the work. You can rename it later.
          </em>
          <input
            className="settings-input"
            type="text"
            value={name}
            placeholder={selected?.suggestedName ?? 'Writer'}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        {delegateTool !== undefined && (
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
              Let Marimo Bot hand work to your bots
              <em className="settings-why">
                {alreadyDelegates
                  ? 'Marimo Bot can already do this.'
                  : 'Without this, Marimo Bot can talk about your bots but cannot ask them to do anything.'}
              </em>
            </span>
          </label>
        )}
        <div className="onboarding-actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={
              busy || name.trim().length === 0 || selected === undefined
            }
          >
            Make this bot
          </button>
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={onBack}
          >
            Back
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * The step-by-step bot: a role, a name, and what it may do.
 *
 * The Role comes from a starter card or from the generic bot contract; a custom
 * bot's job is written in its Persona on the next step, which is what keeps a
 * Role reset from erasing the person's description of the work.
 */
export function BotForm({
  templates,
  presets,
  recommendedId,
  busy,
  delegateTool,
  lead,
  submitLabel,
  onSubmit,
  onBack,
}: {
  templates: readonly BotTemplate[];
  presets: readonly CapabilityPreset[];
  recommendedId: string | undefined;
  busy: boolean;
  /** Absent on a build whose tool set has no delegation, which hides the box. */
  delegateTool: string | undefined;
  lead: AgentProfile | undefined;
  submitLabel: string;
  onSubmit: (draft: BotDraft, delegate: boolean) => Promise<void>;
  onBack: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  const selectedTemplate = templates.find(
    (template) => template.id === templateId,
  );
  /*
   * The recommended preset, which is also what `profiles.create` grants before
   * anything is chosen: the card the user sees lit is the state the bot is
   * actually in. A starter role replaces that with its own grant, which is
   * honest — a Writer's tools are not one of the three sizes.
   */
  const [tools, setTools] = useState<string[]>(
    () => presets.find((preset) => preset.recommended)?.tools ?? [],
  );
  const [delegate, setDelegate] = useState(true);
  const chosen = chosenPreset(presets, tools);

  const alreadyDelegates =
    delegateTool !== undefined &&
    (lead?.enabledTools.includes(delegateTool) ?? false);

  const chooseTemplate = (id: string | undefined): void => {
    setTemplateId(id);
    const template = templates.find((entry) => entry.id === id);
    if (template !== undefined) {
      setTools([...template.tools]);
      setName((current) =>
        current.trim().length === 0 ? template.suggestedName : current,
      );
      return;
    }
    /*
     * Back to scratch: the recommended grant, not the last template's. A Writer
     * that was switched to a custom bot and kept the Writer's tools would be a
     * bot whose Role and grant disagree.
     */
    setTools([...(presets.find((preset) => preset.recommended)?.tools ?? [])]);
  };

  return (
    <>
      <p className="onboarding-lead">
        Pick a role if one fits, or start from scratch. A custom bot&rsquo;s job
        is written in its Persona on the next step.
      </p>
      <BotTemplatePicker
        templates={templates}
        selectedId={templateId}
        recommendedId={recommendedId}
        busy={busy}
        onSelect={chooseTemplate}
      />
      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = name.trim();
          if (trimmed.length === 0 || busy) {
            return;
          }
          void onSubmit(
            {
              name: trimmed,
              ...(templateId === undefined ? {} : {templateId}),
              tools,
            },
            delegate,
          );
        }}
      >
        <label className="settings-field">
          <span>Name</span>
          <em className="settings-why">
            Name it after the work. You can rename it later.
          </em>
          <input
            className="settings-input"
            type="text"
            value={name}
            placeholder={selectedTemplate?.suggestedName ?? 'Writer'}
            autoFocus
            spellCheck={false}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>

        <span className="setup-label">What should it be able to do?</span>
        <div className="capability-cards">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="capability-card"
              aria-pressed={chosen?.id === preset.id}
              disabled={busy}
              onClick={() => {
                setTools([...preset.tools]);
              }}
            >
              <span className="capability-label">
                {preset.label}
                {preset.recommended && (
                  <>
                    {' '}
                    <em className="capability-tag">Recommended</em>
                  </>
                )}
              </span>
              <em className="capability-blurb">{preset.blurb}</em>
            </button>
          ))}
        </div>

        {delegateTool !== undefined && (
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
              Let Marimo Bot hand work to your bots
              <em className="settings-why">
                {alreadyDelegates
                  ? 'Marimo Bot can already do this.'
                  : 'Without this, Marimo Bot can talk about your bots but cannot ask them to do anything.'}
              </em>
            </span>
          </label>
        )}

        <div className="onboarding-actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || name.trim().length === 0}
          >
            {submitLabel}
          </button>
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={onBack}
          >
            Back
          </button>
        </div>
      </form>
    </>
  );
}
