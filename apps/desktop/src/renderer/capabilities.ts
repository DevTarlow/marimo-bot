/**
 * Which card a grant came from.
 *
 * The setup flow offers three bot-creation cards and two control choices, and
 * Settings offers every switch. Behind all of them is the same fact: a list of
 * tool names on the profile. So the card that is lit is *worked out* rather than
 * stored — a grant that matches one of the presets is that preset, and a grant
 * that matches none is a custom set that nobody has to record the existence of.
 * Storing the choice as well would be a second place for it to be wrong, and the
 * two would disagree the first time somebody ticked a box in Settings.
 *
 * Out of the component because this is the part worth pinning. Comparing sets by
 * size is where an off-by-one turns into two cards lit at once, or none, and that
 * is the kind of thing nobody notices until somebody asks which one is on.
 */
import type {CapabilityPreset} from '@marimo/protocol';

/**
 * The preset this grant is, or `undefined` when it is one somebody assembled.
 *
 * Sizes are compared first because it is the cheap half of an equality and it
 * rejects almost everything: equal sizes plus every preset name present means the
 * two sets are equal. A grant holding a name no preset mentions is therefore not
 * a match even when the count lines up — which is the case the size check alone
 * would get wrong.
 */
export function chosenPreset(
  presets: readonly CapabilityPreset[],
  enabledTools: readonly string[],
): CapabilityPreset | undefined {
  const granted = new Set(enabledTools);
  return presets.find(
    (preset) =>
      preset.tools.length === granted.size &&
      preset.tools.every((name) => granted.has(name)),
  );
}
