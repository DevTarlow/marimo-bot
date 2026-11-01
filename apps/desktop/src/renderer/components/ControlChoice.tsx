/**
 * The two answers to "how much should this bot be able to do", as cards.
 *
 * This is the Settings presentation of the grant. The first run asks a slightly
 * larger question — which setup style to take — with its own two cards in
 * `SetupDirection`, because that answer also decides how many steps the flow
 * has. The two presentations still share the catalogue: the labels, the blurbs
 * and the tool lists all come from `profiles.catalog`, so they cannot describe
 * different Standards.
 *
 * The picker only chooses; writing the grant is the caller's business. The lit
 * card is passed in rather than kept here. It is *derived* from the profile's
 * `enabledTools` by the caller, so a switch turned in Settings makes neither
 * card lit instead of leaving this component claiming a tier the profile no
 * longer has.
 */
import type {CapabilityPreset} from '@marimo/protocol';

export function ControlChoice({
  presets,
  chosenId,
  disabled,
  onChoose,
}: {
  presets: readonly CapabilityPreset[];
  /** The preset the current grant matches, or `undefined` for a custom mix. */
  chosenId: string | undefined;
  disabled?: boolean;
  onChoose: (preset: CapabilityPreset) => void;
}): React.JSX.Element {
  return (
    <div className="capability-cards" data-control-choice="">
      {presets.map((preset) => (
        <button
          key={preset.id}
          type="button"
          className="capability-card"
          data-control-preset={preset.id}
          aria-pressed={chosenId === preset.id}
          disabled={disabled}
          onClick={() => {
            onChoose(preset);
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
  );
}
