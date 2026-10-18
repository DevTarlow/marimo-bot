/**
 * The calls that file conversations and manage folders.
 *
 * The shapes the main process checks every inbound call against, tested where
 * the parsing happens rather than through a window: a `null` that the schema
 * refuses is a move that fails with "Invalid parameters" instead of unfiling the
 * conversation, and a whole document that fails its version check is a rail with
 * no folders in it.
 */
import {describe, expect, it} from 'vitest';

import {
  BOT_AVATAR_PRESETS,
  DEFAULT_BOT_AVATAR_ID,
  agentCallSchemas,
  agentProfileSchema,
  botAvatarSchema,
  botAvatarUrl,
  defaultBotAvatarFor,
  workspacesFileSchema,
} from './index.js';

describe('the profile schema', () => {
  it('does not carry folders any more', () => {
    // A file from before folders were install-wide parses, and the fields it
    // used to hold are dropped rather than reaching the renderer as profile
    // fields it might act on.
    const parsed = agentProfileSchema.parse({
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      workspaces: [{id: 'ws', name: 'project', path: '/home/someone/project'}],
      activeWorkspaceId: 'ws',
      enabledTools: [],
      enabledSkills: [],
    });
    expect(parsed).toEqual({
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      enabledTools: [],
      enabledSkills: [],
    });
  });

  /*
   * `persona` is optional on purpose, and this is the test that keeps it so:
   * `ProfileStore.parseFile` skips a profile that fails this schema, and a file
   * whose every profile was skipped is quarantined and replaced with a fresh one.
   * A required field here would lose every existing agent on upgrade.
   */
  it('reads a profile written before Persona existed', () => {
    const parsed = agentProfileSchema.safeParse({
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      enabledTools: [],
      enabledSkills: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.persona : 'unparsed').toBeUndefined();
  });

  it('carries the Persona the person wrote', () => {
    const parsed = agentProfileSchema.parse({
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      persona: 'Dry and precise. Call me Tarlow.',
      enabledTools: [],
      enabledSkills: [],
    });
    expect(parsed.persona).toBe('Dry and precise. Call me Tarlow.');
  });

  /*
   * The old field is still readable because existing files have it and the store
   * adopts it on the way in. This build does not write it; keeping it on the
   * schema is what lets an upgrade read the words instead of quarantining the
   * roster.
   */
  it('still reads the old preferences field', () => {
    const parsed = agentProfileSchema.parse({
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      preferences: 'Call me Tarlow. Skip the emoji.',
      enabledTools: [],
      enabledSkills: [],
    });
    expect(parsed.preferences).toBe('Call me Tarlow. Skip the emoji.');
  });

  /*
   * The space an agent starts new chats in, and the same rule as `persona`
   * above: it is optional because `ProfileStore.parseFile` skips a profile this
   * schema refuses, and a file whose every profile was skipped is quarantined —
   * so a required field here would lose every existing agent on upgrade.
   */
  it('reads a profile written before an agent could have a space', () => {
    const parsed = agentProfileSchema.safeParse({
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      enabledTools: [],
      enabledSkills: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.spaceId : 'unparsed').toBeUndefined();
  });

  it('carries the space the user pointed an agent at', () => {
    const parsed = agentProfileSchema.parse({
      id: 'agent',
      name: 'Writer',
      identity: 'You are an agent.',
      spaceId: 'ws-website',
      enabledTools: [],
      enabledSkills: [],
    });
    expect(parsed.spaceId).toBe('ws-website');
  });

  it('lets a patch move an agent back to wherever the rail is', () => {
    const parsed = agentCallSchemas['profiles.update'].parse({
      profileId: 'agent',
      patch: {spaceId: null},
    });
    // A third answer beside "absent" and "a value": without the null the picker
    // could only ever move an agent onto a space, never off one.
    expect(parsed.patch.spaceId).toBeNull();
    expect(
      agentCallSchemas['profiles.update'].safeParse({
        profileId: 'agent',
        patch: {spaceId: ''},
      }).success,
    ).toBe(false);
  });

  it('lets a patch clear Persona with an empty string', () => {
    const parsed = agentCallSchemas['profiles.update'].parse({
      profileId: 'agent',
      patch: {persona: ''},
    });
    // Not `undefined`: "clear it" and "say nothing about it" are different
    // requests, and the store tells them apart by exactly this.
    expect(parsed.patch.persona).toBe('');
  });

  /*
   * Removal is one call because it destroys more than the profile — the bot's
   * conversations, its jobs and its memory go with it. A blank id would be a
   * request to destroy the things belonging to no bot at all.
   */
  it('names the bot to remove, and will not take an empty one', () => {
    const parsed = agentCallSchemas['profiles.remove'].parse({
      profileId: 'agent',
    });
    expect(parsed.profileId).toBe('agent');
    expect(
      agentCallSchemas['profiles.remove'].safeParse({profileId: ''}).success,
    ).toBe(false);
  });
});

describe('the workspaces document', () => {
  it('round-trips folders and the current one', () => {
    const parsed = workspacesFileSchema.parse({
      version: 2,
      workspaces: [{id: 'ws', name: 'project', path: '/home/someone/project'}],
      activeWorkspaceId: 'ws',
    });
    expect(parsed.activeWorkspaceId).toBe('ws');
    expect(parsed.workspaces).toHaveLength(1);
  });

  it('allows no current folder, which is an install with none', () => {
    const parsed = workspacesFileSchema.parse({
      version: 2,
      workspaces: [],
      activeWorkspaceId: null,
    });
    expect(parsed.activeWorkspaceId).toBeNull();
  });

  /*
   * The schema knows only the shape this build writes. Version 1 is the same
   * shape under the previous marker, so accepting it here would let a v1 file be
   * read without the seed move ever being considered; the store is where the
   * upgrade belongs.
   */
  it('refuses the version the store upgrades before parsing', () => {
    expect(
      workspacesFileSchema.safeParse({
        version: 1,
        workspaces: [],
        activeWorkspaceId: null,
      }).success,
    ).toBe(false);
  });

  it('refuses a version this build does not know', () => {
    expect(
      workspacesFileSchema.safeParse({
        version: 3,
        workspaces: [],
        activeWorkspaceId: null,
      }).success,
    ).toBe(false);
  });

  it('refuses a blank folder name rather than persisting one', () => {
    expect(
      workspacesFileSchema.safeParse({
        version: 2,
        workspaces: [{id: 'ws', name: '   ', path: '/tmp/x'}],
        activeWorkspaceId: 'ws',
      }).success,
    ).toBe(false);
  });
});

describe('the workspace calls', () => {
  it('accepts a folder named by path, and none at all for the picker', () => {
    expect(agentCallSchemas['workspaces.add'].safeParse({}).success).toBe(true);
    expect(
      agentCallSchemas['workspaces.add'].safeParse({path: '/home/someone/p'})
        .success,
    ).toBe(true);
    expect(
      agentCallSchemas['workspaces.add'].safeParse({path: ''}).success,
    ).toBe(false);
  });

  it('refuses a blank id on every call that names a folder', () => {
    for (const method of [
      'workspaces.select',
      'workspaces.rename',
      'workspaces.remove',
      'workspaces.open',
    ] as const) {
      expect(
        agentCallSchemas[method].safeParse({workspaceId: ''}).success,
      ).toBe(false);
    }
  });

  it('trims a new folder name and refuses a blank one', () => {
    const parsed = agentCallSchemas['workspaces.rename'].parse({
      workspaceId: 'ws',
      name: '  Client work  ',
    });
    expect(parsed.name).toBe('Client work');
    expect(
      agentCallSchemas['workspaces.rename'].safeParse({
        workspaceId: 'ws',
        name: '   ',
      }).success,
    ).toBe(false);
  });
});

describe('the filing calls', () => {
  it('starts a conversation in a named space, or with none named', () => {
    const named = agentCallSchemas['sessions.create'].parse({
      profileId: 'p',
      spaceId: 'ws-website',
    });
    expect(named.spaceId).toBe('ws-website');

    // Absent is the common case, and it is not "no space": the runtime resolves
    // it to the agent's own or to the rail's, which is why nothing here may
    // turn it into a value.
    expect(
      agentCallSchemas['sessions.create'].parse({profileId: 'p'}).spaceId,
    ).toBeUndefined();
    expect(
      agentCallSchemas['sessions.create'].safeParse({
        profileId: 'p',
        spaceId: '',
      }).success,
    ).toBe(false);
  });

  it('accepts an id to move to, and null to unfile', () => {
    const toFolder = agentCallSchemas['sessions.move'].parse({
      profileId: 'p',
      sessionId: 's',
      workspaceId: 'ws',
    });
    expect(toFolder.workspaceId).toBe('ws');

    const unfiled = agentCallSchemas['sessions.move'].parse({
      profileId: 'p',
      sessionId: 's',
      workspaceId: null,
    });
    expect(unfiled.workspaceId).toBeNull();
  });

  it('requires an explicit filing rather than treating an absent one as unfiling', () => {
    // `undefined` would be a move that silently unfiled a conversation for a
    // caller that forgot to send the field.
    expect(
      agentCallSchemas['sessions.move'].safeParse({
        profileId: 'p',
        sessionId: 's',
      }).success,
    ).toBe(false);
  });

  it('trims a new title and refuses a blank one', () => {
    const parsed = agentCallSchemas['sessions.rename'].parse({
      profileId: 'p',
      sessionId: 's',
      title: '  Release prep  ',
    });
    expect(parsed.title).toBe('Release prep');
    expect(
      agentCallSchemas['sessions.rename'].safeParse({
        profileId: 'p',
        sessionId: 's',
        title: '   ',
      }).success,
    ).toBe(false);
  });

  it('names the conversation to delete', () => {
    expect(
      agentCallSchemas['sessions.delete'].safeParse({
        profileId: 'p',
        sessionId: 's',
      }).success,
    ).toBe(true);
    expect(
      agentCallSchemas['sessions.delete'].safeParse({profileId: 'p'}).success,
    ).toBe(false);
  });

  it('names the conversation a command acts on', () => {
    expect(
      agentCallSchemas['sessions.compact'].safeParse({
        profileId: 'p',
        sessionId: 's',
      }).success,
    ).toBe(true);
    // No text: a command is not something the user said, and a body would be one
    // more field the window has to fill in for nothing.
    expect(
      agentCallSchemas['sessions.compact'].safeParse({profileId: 'p'}).success,
    ).toBe(false);
  });

  it('names the model a conversation is pointed at, or says to stop', () => {
    /*
     * A conversation may answer with a model of its own — the app's default, its
     * agent's, or this one question's — and the call has to be able to express all
     * three. `null` is the third: "follow the agent again", which a schema that
     * only took a model would have no way to say.
     */
    expect(
      agentCallSchemas['sessions.setModel'].safeParse({
        profileId: 'p',
        sessionId: 's',
        model: {provider: 'deepseek', model: 'deepseek-v4-pro'},
      }).success,
    ).toBe(true);
    expect(
      agentCallSchemas['sessions.setModel'].safeParse({
        profileId: 'p',
        sessionId: 's',
        model: null,
      }).success,
    ).toBe(true);
    // A bare model id is refused: it means nothing without the endpoint, and a
    // guess at which provider it belonged to is how a chat silently changes
    // provider.
    expect(
      agentCallSchemas['sessions.setModel'].safeParse({
        profileId: 'p',
        sessionId: 's',
        model: 'deepseek-v4-pro',
      }).success,
    ).toBe(false);
    expect(
      agentCallSchemas['sessions.setModel'].safeParse({
        sessionId: 's',
        model: null,
      }).success,
    ).toBe(false);
  });
});

describe('a bot icon', () => {
  it('offers five stable presets, with Marimo as the default', () => {
    expect(BOT_AVATAR_PRESETS.map((preset) => preset.id)).toEqual([
      'marimo',
      'sprout',
      'pebble',
      'wave',
      'spark',
    ]);
    expect(DEFAULT_BOT_AVATAR_ID).toBe('marimo');
    expect(defaultBotAvatarFor(0)).toEqual({kind: 'preset', id: 'marimo'});
    expect(defaultBotAvatarFor(1)).toEqual({kind: 'preset', id: 'sprout'});
    // A wrap is deliberate: a sixth bot starting at Marimo again is better than
    // one with no icon.
    expect(defaultBotAvatarFor(5)).toEqual({kind: 'preset', id: 'marimo'});
    expect(defaultBotAvatarFor(-1)).toEqual({kind: 'preset', id: 'spark'});
  });

  it('parses an absent icon and a malformed one without dropping the profile', () => {
    const base = {
      id: 'agent',
      name: 'Agent',
      identity: 'You are an agent.',
      enabledTools: [],
      enabledSkills: [],
    };
    expect(agentProfileSchema.parse(base).avatar).toBeUndefined();
    // A hand-edited or newer value costs the picture, not the bot. This is the
    // reason the field is optional and carries a catch.
    const malformed = agentProfileSchema.parse({
      ...base,
      avatar: {kind: 'from-the-future', id: 'x'},
    });
    expect(malformed.avatar).toBeUndefined();
  });

  it('keeps an unknown preset id parseable for the renderer to fall back from', () => {
    expect(
      botAvatarSchema.parse({kind: 'preset', id: 'a-new-shape'}).id,
    ).toBe('a-new-shape');
  });

  it('lets a patch clear the icon, and the upload call names the bot', () => {
    const patch = agentCallSchemas['profiles.update'].parse({
      profileId: 'agent',
      patch: {avatar: null},
    });
    expect(patch.patch.avatar).toBeNull();
    expect(
      agentCallSchemas['profiles.uploadAvatar'].safeParse({profileId: ''})
        .success,
    ).toBe(false);
  });

  it('builds a versioned URL the asset handler can read back', () => {
    const url = botAvatarUrl('bot/with spaces', 'version 1');
    expect(url.startsWith('marimo-asset://bot/')).toBe(true);
    expect(url).toContain('bot%2Fwith%20spaces.png');
    expect(url).toContain('v=version%201');
  });
});
