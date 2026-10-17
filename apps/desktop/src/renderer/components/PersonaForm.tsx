/**
 * The one field about a bot that belongs to the person rather than to the app.
 *
 * It is the bot's character, its job in the person's words, and how they want to
 * be spoken to — one text because they are one idea to the person, and because a
 * second box for "how to talk to me" was a second place to look for something
 * they had already said. The Role above it is the app's brief; this is theirs.
 *
 * The starter text is shown, not hidden behind a button, because the person is
 * the one who knows what to change about it. Saving an empty box clears it: the
 * starter text is a seed, and somebody who deleted it meant to.
 *
 * Back saves before it leaves. A person who typed a paragraph and then went to
 * look at the Role again should not find the paragraph gone when they return,
 * and the write is the same one the Save button makes.
 */
import {useState} from 'react';

const SUGGESTIONS = [
  'Dry and precise. Never flatters me.',
  'Warm but brief. Say when you are unsure.',
  'Call me by my first name.',
] as const;

export function PersonaForm({
  name,
  initial,
  busy,
  onSubmit,
  onBack,
  onSkip,
}: {
  name: string;
  /** The seeded text, shown as the starting point. */
  initial: string;
  busy: boolean;
  /** Saves the text, including an empty one. */
  onSubmit: (text: string) => Promise<void>;
  /** Saves the text and returns to the bot's step. */
  onBack: (text: string) => Promise<void>;
  /** Leaves the seed exactly as it is. */
  onSkip: () => void;
}): React.JSX.Element {
  const [text, setText] = useState(initial);

  const add = (line: string): void => {
    const trimmed = text.trim();
    setText(trimmed.length === 0 ? line : `${trimmed}\n${line}`);
  };

  return (
    <form
      className="setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) {
          void onSubmit(text);
        }
      }}
    >
      <label className="settings-field">
        <span>Persona</span>
        <em className="settings-why">
          Your text. The app will not reset it.
        </em>
        <textarea
          className="settings-input settings-preferences"
          rows={7}
          aria-label={`Persona for ${name}`}
          placeholder="Dry and precise, never flatters me. Call me Tarlow, and say when you are unsure rather than guessing."
          value={text}
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </label>

      <div className="settings-row">
        {SUGGESTIONS.map((line) => (
          <button
            key={line}
            type="button"
            className="button button-quiet button-small"
            disabled={busy}
            onClick={() => {
              add(line);
            }}
          >
            {line}
          </button>
        ))}
      </div>

      <div className="onboarding-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          Save and continue
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={busy}
          onClick={onSkip}
        >
          Keep the starter text
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={busy}
          onClick={() => {
            void onBack(text);
          }}
        >
          Back
        </button>
      </div>
    </form>
  );
}
