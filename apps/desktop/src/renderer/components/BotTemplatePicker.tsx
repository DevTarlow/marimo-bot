/**
 * The starter roles, as cards.
 *
 * One component rather than a copy in the setup flow and another in Settings:
 * the list, the narrowing and the wording all come from `profiles.catalog`, and
 * a second rendering would be a second answer to what a Writer is. The picker
 * only chooses; what happens next is the caller's business.
 */
import type {BotTemplate} from '@marimo/protocol';

export function BotTemplatePicker({
  templates,
  selectedId,
  recommendedId,
  busy,
  allowCustom = true,
  onSelect,
}: {
  templates: readonly BotTemplate[];
  /** The chosen template, or `undefined` for a custom bot. */
  selectedId: string | undefined;
  /**
   * The starter role the setup's goals suggest, when one fits.
   *
   * A tag, not a preselected grant: the person still chooses, and a goal whose
   * role this install does not carry simply has no suggestion.
   */
  recommendedId?: string;
  busy?: boolean;
  /**
   * Whether the "start from scratch" card is offered.
   *
   * False in the starter-role form: that path is *for* a starter role, and a
   * scratch card there would be a choice that disabled the button under it. The
   * step-by-step path and the Settings dialog offer it because they can act on
   * it.
   */
  allowCustom?: boolean;
  onSelect: (id: string | undefined) => void;
}): React.JSX.Element {
  return (
    <div className="bot-template-grid">
      {templates.map((template) => (
        <button
          key={template.id}
          type="button"
          className="bot-template-card"
          aria-pressed={selectedId === template.id}
          disabled={busy}
          onClick={() => {
            onSelect(template.id);
          }}
        >
          <span className="bot-template-label">
            {template.label}
            {recommendedId === template.id && (
              <>
                {' '}
                <em className="capability-tag">Suggested</em>
              </>
            )}
          </span>
          <em className="bot-template-blurb">{template.blurb}</em>
        </button>
      ))}
      {allowCustom && (
        <button
          type="button"
          className="bot-template-card bot-template-custom"
          aria-pressed={selectedId === undefined}
          disabled={busy}
          onClick={() => {
            onSelect(undefined);
          }}
        >
          <span className="bot-template-label">Start from scratch</span>
          <em className="bot-template-blurb">
            No starter role. Its persona says what it is for.
          </em>
        </button>
      )}
    </div>
  );
}
