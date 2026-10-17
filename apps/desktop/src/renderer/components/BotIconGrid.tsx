/**
 * The shipped icons, as a grid of choices.
 *
 * Settings and the setup flow both offer the five presets, and a second copy of
 * this markup would be a second answer to "what does Spark look like on a card".
 * Uploading an image stays with the caller: it needs the profile to exist in the
 * store, and the two screens reach that point differently.
 */
import {BOT_AVATAR_PRESETS} from '@marimo/protocol';
import type {AgentProfile} from '@marimo/protocol';

import {BotAvatar} from './BotAvatar.js';

export function BotIconGrid({
  profile,
  selectedId,
  disabled,
  onSelect,
}: {
  profile: Pick<AgentProfile, 'id' | 'name' | 'avatar'>;
  /** The chosen preset, or `undefined` when the bot wears something else. */
  selectedId: string | undefined;
  disabled: boolean;
  onSelect: (presetId: string) => void;
}): React.JSX.Element {
  return (
    <div className="settings-avatars">
      {BOT_AVATAR_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          className="settings-avatar-choice"
          data-avatar-id={preset.id}
          aria-pressed={preset.id === selectedId}
          disabled={disabled}
          onClick={() => {
            onSelect(preset.id);
          }}
        >
          <BotAvatar
            profile={{...profile, avatar: {kind: 'preset', id: preset.id}}}
            size="md"
          />
          <span>{preset.label}</span>
        </button>
      ))}
    </div>
  );
}
