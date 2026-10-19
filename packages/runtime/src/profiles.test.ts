/**
 * Agent profiles on disk.
 *
 * The interesting parts are the invariants: there is always an active profile,
 * deleting a profile never claims the last one or touches a user's files, and
 * the folders a pre-workspaces file carried are preserved until the store that
 * now owns them has taken them.
 */
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {DEFAULT_AGENT_PERSONA, DEFAULT_AGENT_ROLE} from '@marimo/protocol';

import {
  LastProfileError,
  ProfileStore,
  UnknownProfileError,
} from './profiles.js';
import type {NewProfileSeed} from './profiles.js';

const TOOLS = ['read_file', 'write_file', 'run_shell'];
const SKILLS = ['reasoning', 'memory'];

describe('ProfileStore', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-profiles-'));
    file = join(dir, 'profiles.json');
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): ProfileStore {
    return new ProfileStore({
      file,
      defaultRole: 'You are an agent.',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: TOOLS,
      defaultSkills: SKILLS,
    });
  }

  /** A resolved seed, the shape the runtime hands the store. */
  function seed(name: string): NewProfileSeed {
    return {
      name,
      role: (called) => `You are ${called}.`,
      persona: 'A test persona.',
    };
  }

  it('seeds one profile with the app defaults on first run', async () => {
    const snapshot = await store().load();
    expect(snapshot.profiles).toHaveLength(1);
    const profile = snapshot.profiles[0];
    expect(profile?.name).toBe('Marimo Bot');
    expect(profile?.identity).toBe('You are an agent.');
    expect(profile?.enabledTools).toEqual(TOOLS);
    expect(profile?.enabledSkills).toEqual(SKILLS);
  });

  it('keeps the prompt a pre-profile install had', async () => {
    const snapshot = await store().load({
      systemPrompt: 'You are the old prompt.',
    });
    expect(snapshot.profiles[0]?.identity).toBe('You are the old prompt.');
  });

  it('persists across stores', async () => {
    const first = store();
    await first.create(seed('Research'));
    const reopened = await store().load();
    expect(reopened.profiles.map((profile) => profile.name)).toEqual([
      'Marimo Bot',
      'Research',
    ]);
    expect(reopened.activeProfileId).toBe(
      reopened.profiles[1]?.id ?? 'missing',
    );
  });

  it('moves the active pointer on select, and refuses an unknown one', async () => {
    const profiles = store();
    const first = await profiles.activeProfile();
    const second = await profiles.create(seed('Second'));
    expect(await profiles.activeProfileId()).toBe(second.id);

    await profiles.select(first.id);
    expect(await profiles.activeProfileId()).toBe(first.id);
    expect((await profiles.activeProfile()).name).toBe(first.name);

    await expect(profiles.select('missing')).rejects.toBeInstanceOf(
      UnknownProfileError,
    );
  });

  it('falls back when the stored active profile no longer exists', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeProfileId: 'ghost',
        profiles: [
          {
            id: 'real',
            name: 'Real',
            identity: '',
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      }),
      'utf8',
    );
    const snapshot = await store().load();
    expect(snapshot.activeProfileId).toBe('real');
  });

  it('preserves an unreadable file instead of overwriting it', async () => {
    const original = '{ "profiles": "not an array" }';
    await writeFile(file, original, 'utf8');
    await store().load();
    // The unusable file is kept under another name, so a parse bug can never be
    // the end of a user's agents.
    const {readdir} = await import('node:fs/promises');
    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.includes('unreadable'))).toBe(true);
  });

  it('creates a profile with unique names and switches to it', async () => {
    const profiles = store();
    const one = await profiles.create(seed('Agent'));
    const two = await profiles.create(seed('Agent'));
    expect(one.id).not.toBe(two.id);
    expect(two.name).toBe('Agent 2');
    expect(await profiles.activeProfileId()).toBe(two.id);
  });

  it('updates identity, tools and skills without duplicating names', async () => {
    const profiles = store();
    const profile = await profiles.activeProfile();
    const updated = await profiles.update(profile.id, {
      identity: 'You are a researcher.',
      enabledTools: ['read_file', 'read_file'],
      enabledSkills: [],
    });
    expect(updated.identity).toBe('You are a researcher.');
    expect(updated.enabledTools).toEqual(['read_file']);
    expect(updated.enabledSkills).toEqual([]);
  });

  it("keeps the person's Persona beside the app's Role", async () => {
    const profiles = store();
    const profile = await profiles.activeProfile();
    const updated = await profiles.update(profile.id, {
      persona: 'Call me Tarlow. Skip the emoji.',
    });
    expect(updated.persona).toBe('Call me Tarlow. Skip the emoji.');
    // The Role is the app's text and writing Persona does not touch it: Reset
    // has to be able to restore one without touching the other.
    expect(updated.identity).toBe(profile.identity);
  });

  it('tells a cleared Persona apart from one never mentioned', async () => {
    const profiles = store();
    const profile = await profiles.activeProfile();
    await profiles.update(profile.id, {persona: 'Be blunt.'});
    // A patch that says nothing about it leaves it alone.
    const renamed = await profiles.update(profile.id, {name: 'Other'});
    expect(renamed.persona).toBe('Be blunt.');
    // An empty string is the person clearing the box, and it lands as empty
    // rather than as a no-op on the way to the store.
    const cleared = await profiles.update(profile.id, {persona: ''});
    expect(cleared.persona).toBe('');
  });

  it('starts a new profile with the Persona it was seeded with', async () => {
    const profiles = store();
    const created = await profiles.create(seed('Researcher'));
    expect(created.persona).toBe('A test persona.');
  });

  /*
   * The old "How to talk to me" text is moved into Persona on the way in, not
   * dropped and not left in a field this build no longer writes. A read that
   * never writes still shows the words; the next write persists the move.
   */
  it('adopts old preferences into Persona on read', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeProfileId: 'agent',
        profiles: [
          {
            id: 'agent',
            name: 'Agent',
            identity: 'You are an agent.',
            preferences: 'Call me Tarlow. Skip the emoji.',
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      }),
      'utf8',
    );

    const loaded = await store().load();
    expect(loaded.profiles[0]?.persona).toBe('Call me Tarlow. Skip the emoji.');
    expect(loaded.profiles[0]?.preferences).toBeUndefined();
  });

  /*
   * The two seeds, and the reason there are two. The first profile is the lead —
   * the agent the person talks to — and only it gets the app's Role and Persona.
   * A bot gets its own resolved pair, because a bot seeded with the lead's text
   * introduces itself as Marimo Bot and is told to hand work to bots, which it
   * has no tool to do.
   */
  it('seeds the lead with the app pair and a bot with its own name', async () => {
    const profiles = new ProfileStore({
      file,
      defaultRole: DEFAULT_AGENT_ROLE,
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: TOOLS,
      defaultSkills: SKILLS,
    });

    const [lead] = (await profiles.load()).profiles;
    expect(lead?.identity).toBe(DEFAULT_AGENT_ROLE);
    expect(lead?.persona).toBe(DEFAULT_AGENT_PERSONA);

    const writer = await profiles.create(seed('Writer'));
    expect(writer.identity).toContain('Writer');
    expect(writer.identity).not.toContain('You are Marimo Bot');
    expect(writer.persona).toBe('A test persona.');
  });

  /*
   * The connector grant, which is one of the fields a patch can *unset*.
   *
   * All three answers a user can give have to survive the store: a list means
   * "only these", an empty list means "none", and `null` means "back to every
   * connector" — which is the field being *gone*, not an empty list, because the
   * two are opposite answers. A patch that says nothing leaves whatever is there,
   * which is what makes the switch beside a server safe to leave alone.
   */
  it('stores the connector grant, and unsets it with a null', async () => {
    const profiles = store();
    const profile = await profiles.activeProfile();
    expect(profile.mcpServerIds).toBeUndefined();

    const some = await profiles.update(profile.id, {
      mcpServerIds: ['mcp:notes', 'mcp:notes', 'mcp:mail'],
    });
    expect(some.mcpServerIds).toEqual(['mcp:notes', 'mcp:mail']);

    const none = await profiles.update(profile.id, {mcpServerIds: []});
    expect(none.mcpServerIds).toEqual([]);

    // Unset rather than emptied: absent is what every connector means.
    const all = await profiles.update(profile.id, {mcpServerIds: null});
    expect(all.mcpServerIds).toBeUndefined();

    // And a patch about something else does not disturb the grant.
    await profiles.update(profile.id, {mcpServerIds: ['mcp:notes']});
    const renamed = await profiles.update(profile.id, {name: 'Other'});
    expect(renamed.mcpServerIds).toEqual(['mcp:notes']);
  });

  /*
   * The model, which is another field a patch can unset, and which was in the
   * schema without the store ever writing it — so the picker in Settings moved a
   * value nothing kept.
   */
  it("stores the agent's own model, and unsets it with a null", async () => {
    const profiles = store();
    const profile = await profiles.activeProfile();

    const chosen = await profiles.update(profile.id, {
      model: {provider: 'gemini', model: 'gemini-3.1-pro'},
    });
    expect(chosen.model).toEqual({
      provider: 'gemini',
      model: 'gemini-3.1-pro',
    });

    const back = await profiles.update(profile.id, {model: null});
    expect(back.model).toBeUndefined();
  });

  /*
   * The space an agent starts new chats in, and another field a patch can
   * unset. It is what lets a person say once that their Writer drafts into the
   * website repo, rather than saying it again in every new chat.
   */
  it('stores the space an agent works in, and unsets it with a null', async () => {
    const profiles = store();
    const profile = await profiles.activeProfile();
    expect(profile.spaceId).toBeUndefined();

    const chosen = await profiles.update(profile.id, {spaceId: 'ws-website'});
    expect(chosen.spaceId).toBe('ws-website');
    // Round-tripped: a store reopened on the same file answers with it.
    expect((await store().profiles())[0]?.spaceId).toBe('ws-website');

    // Unset rather than left as a sentinel. Absent *is* "wherever the rail is",
    // and a null stored here would be a profile its own schema refuses — which
    // the next read would skip and, if it were the only one, quarantine.
    const back = await profiles.update(profile.id, {spaceId: null});
    expect(back.spaceId).toBeUndefined();

    // And a patch about something else does not disturb it.
    await profiles.update(profile.id, {spaceId: 'ws-website'});
    const renamed = await profiles.update(profile.id, {name: 'Other'});
    expect(renamed.spaceId).toBe('ws-website');
  });

  it('reads a profile file written before agents had a space', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeProfileId: 'writer',
        profiles: [
          {
            id: 'writer',
            name: 'Writer',
            identity: '',
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      }),
      'utf8',
    );
    const snapshot = await store().load();
    // Parsed rather than skipped: a field added to the schema may not cost a
    // user the agent that predates it.
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.profiles[0]?.spaceId).toBeUndefined();
  });

  it('refuses an unknown profile', async () => {
    await expect(store().update('nope', {name: 'x'})).rejects.toBeInstanceOf(
      UnknownProfileError,
    );
  });

  it('refuses to delete the last profile', async () => {
    const profiles = store();
    const profile = await profiles.activeProfile();
    await expect(profiles.remove(profile.id)).rejects.toBeInstanceOf(
      LastProfileError,
    );
  });

  it('moves the active profile when the active one is deleted', async () => {
    const profiles = store();
    const second = await profiles.create(seed('Second'));
    const snapshot = await profiles.remove(second.id);
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.activeProfileId).toBe(snapshot.profiles[0]?.id);
  });

  it('recovers from a corrupt file by seeding a fresh profile', async () => {
    await writeFile(file, '{ not json', 'utf8');
    const snapshot = await store().load();
    expect(snapshot.profiles).toHaveLength(1);
    // And the file is usable again.
    const repaired = JSON.parse(await readFile(file, 'utf8')) as {
      profiles: unknown[];
    };
    expect(repaired.profiles).toHaveLength(1);
  });

  it('drops a profile that does not match the schema', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeProfileId: 'good',
        profiles: [
          {
            id: 'good',
            name: 'Good',
            identity: '',
            enabledTools: [],
            enabledSkills: [],
          },
          {id: 'bad', name: '', identity: 42},
        ],
      }),
      'utf8',
    );
    const snapshot = await store().load();
    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(['good']);
    expect(snapshot.activeProfileId).toBe('good');
  });

  /*
   * The first-run race.
   *
   * The window and the headless runner — or simply two calls from one of them —
   * can ask for the profile file before either has read it. Both then find no
   * file, both create a profile, and both write: each holds a profile with its
   * own random id, only one is on disk, and the other caller is left with an
   * agent that does not exist. It showed up as "there is no agent called <id>"
   * from a window that had been handed that id a moment earlier.
   *
   * Memoising the read as a *promise* rather than as a value is the fix: the
   * second caller waits for the first instead of starting its own.
   */
  it('gives concurrent first reads the same profile', async () => {
    const instance = store();
    const [first, second, third] = await Promise.all([
      instance.load(),
      instance.load(),
      instance.load(),
    ]);

    expect(first.activeProfileId).toBe(second.activeProfileId);
    expect(second.activeProfileId).toBe(third.activeProfileId);
    expect(first.profiles).toHaveLength(1);
  });

  it('leaves exactly one profile on disk after concurrent first reads', async () => {
    const instance = store();
    await Promise.all([instance.load(), instance.load()]);

    // Re-read from a fresh store, so this is what was actually written rather
    // than what a cache remembers.
    const reread = await store().load();
    expect(reread.profiles).toHaveLength(1);
  });
});

/*
 * Invariant 12, for the file that holds the user's agents.
 *
 * Both failures here look alike and are not. A profiles file from a newer build
 * either parses and is then overwritten as version 1 — silently dropping
 * whatever that build added — or fails to parse and is quarantined, which renames
 * the user's agents out of the way and starts fresh. The second looks exactly
 * like having lost them.
 */
describe('an agents file from a newer build', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-too-new-'));
    file = join(dir, 'profiles.json');
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): ProfileStore {
    return new ProfileStore({
      file,
      defaultRole: 'You are an agent.',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: TOOLS,
      defaultSkills: SKILLS,
    });
  }

  /** A resolved seed, the shape the runtime hands the store. */
  function seed(name: string): NewProfileSeed {
    return {
      name,
      role: (called) => `You are ${called}.`,
      persona: 'A test persona.',
    };
  }

  /** A file a future build wrote: a version this one does not know. */
  async function writeFuture(): Promise<void> {
    await writeFile(
      file,
      JSON.stringify({
        version: 99,
        profiles: [{id: 'someone', name: 'Their agent'}],
        activeProfileId: 'someone',
      }),
      'utf8',
    );
  }

  it('refuses to open it, saying which version it is', async () => {
    await writeFuture();
    await expect(store().load()).rejects.toThrow(/newer version/u);
  });

  /*
   * The important half. A refusal that has already renamed the file is not a
   * refusal, and "unreadable-<timestamp>" beside a fresh profiles.json is
   * indistinguishable from the agents having been deleted.
   */
  it('leaves the file exactly where it is', async () => {
    await writeFuture();
    const before = await readFile(file, 'utf8');

    await store()
      .load()
      .catch(() => undefined);

    const entries = await readdir(dir);
    expect(entries.filter((entry) => entry.includes('unreadable'))).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('refuses to write over it, even for a change that would otherwise work', async () => {
    await writeFuture();
    const profiles = store();

    await expect(profiles.create(seed('Another'))).rejects.toThrow(
      /newer version/u,
    );

    // And the file is still the newer build's.
    const after = JSON.parse(await readFile(file, 'utf8')) as {version: number};
    expect(after.version).toBe(99);
  });
});

/*
 * A profiles file with no version at all.
 *
 * This app has always stamped one — `freshFile` writes `version: 1` — so a file
 * without one is something else: a truncated write, another program's file, or a
 * hand-edit. The version machinery refuses to guess, which is the safe half of
 * the trade, and the store preserves the file rather than replacing it.
 *
 * Worth being precise about, because an earlier version of this test asserted the
 * profile came back named "Marimo Bot" — which a *freshly created* profile is also
 * called, so it passed while the file was being thrown away.
 */
describe('an agents file with no version', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-unversioned-'));
    file = join(dir, 'profiles.json');
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('preserves it rather than replacing it, and carries on with a fresh one', async () => {
    const original = JSON.stringify({
      profiles: [
        {
          id: 'someone-elses-agent',
          name: 'Theirs',
          identity: 'You are an agent.',
          enabledTools: [],
          enabledSkills: [],
        },
      ],
      activeProfileId: 'someone-elses-agent',
    });
    await writeFile(file, original, 'utf8');

    const snapshot = await new ProfileStore({
      file,
      defaultRole: '',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: TOOLS,
      defaultSkills: SKILLS,
    }).load();

    // A fresh agent, and *not* the id from the file — which is the assertion the
    // earlier version of this test was missing.
    expect(snapshot.profiles.map((profile) => profile.id)).not.toContain(
      'someone-elses-agent',
    );

    // And the original is still on disk under another name, not gone.
    const entries = await readdir(dir);
    const kept = entries.find((entry) => entry.includes('unreadable'));
    expect(kept).toBeDefined();
    expect(await readFile(join(dir, kept ?? ''), 'utf8')).toBe(original);
  });
});

/*
 * The folders a pre-workspaces file carried.
 *
 * They are another document's data now, and this is the half that matters: a
 * profile edited during the upgrade — a rename, a new tool — must not be the
 * write that drops them, because until the workspaces store has written its own
 * document they are the only copy.
 */
describe('the folders a pre-workspaces file carried', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-legacy-ws-'));
    file = join(dir, 'profiles.json');
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): ProfileStore {
    return new ProfileStore({
      file,
      defaultRole: 'You are an agent.',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: TOOLS,
      defaultSkills: SKILLS,
    });
  }

  async function writeLegacy(): Promise<void> {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeProfileId: 'agent',
        profiles: [
          {
            id: 'agent',
            name: 'Agent',
            identity: 'You are an agent.',
            workspaces: [
              {id: 'ws-a', name: 'alpha', path: join(dir, 'alpha')},
              {id: 'ws-b', name: 'beta', path: join(dir, 'beta')},
            ],
            activeWorkspaceId: 'ws-b',
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      }),
      'utf8',
    );
  }

  it('reads them off the file without putting them on the profile', async () => {
    await writeLegacy();
    const profiles = store();
    const legacy = await profiles.legacyWorkspaces();
    expect(legacy).toEqual([
      {
        profileId: 'agent',
        workspaces: [
          {id: 'ws-a', name: 'alpha', path: join(dir, 'alpha')},
          {id: 'ws-b', name: 'beta', path: join(dir, 'beta')},
        ],
        activeWorkspaceId: 'ws-b',
      },
    ]);
    expect((await profiles.activeProfile()).id).toBe('agent');
  });

  it('keeps them on disk through an unrelated profile edit', async () => {
    await writeLegacy();
    const profiles = store();
    await profiles.update('agent', {name: 'Renamed'});

    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      profiles: Array<{name: string; workspaces?: unknown[]}>;
    };
    expect(raw.profiles[0]?.name).toBe('Renamed');
    expect(raw.profiles[0]?.workspaces).toHaveLength(2);
  });

  it('drops them only when told the adoption is done', async () => {
    await writeLegacy();
    const profiles = store();
    await profiles.clearLegacy();

    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      profiles: Array<{workspaces?: unknown[]; activeWorkspaceId?: unknown}>;
    };
    expect(raw.profiles[0]?.workspaces).toBeUndefined();
    expect(raw.profiles[0]?.activeWorkspaceId).toBeUndefined();
    // And nothing is left to adopt, so a second call is a no-op.
    expect(await profiles.legacyWorkspaces()).toBeUndefined();
  });
});

/*
 * The icon, which is the first profile field the user can replace with a file.
 *
 * What matters is that the pointer is optional and never decides whether the
 * bot exists. The picture is a file beside the profile; the profile carried a
 * marker and a version, and every failure of that marker falls back to an icon
 * rather than to a skipped profile.
 */
describe('ProfileStore avatars', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-avatars-'));
    file = join(dir, 'profiles.json');
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function store(): ProfileStore {
    return new ProfileStore({
      file,
      defaultRole: 'You are an agent.',
      defaultPersona: DEFAULT_AGENT_PERSONA,
      defaultTools: TOOLS,
      defaultSkills: SKILLS,
    });
  }

  /** A resolved seed, the shape the runtime hands the store. */
  function seed(name: string): NewProfileSeed {
    return {
      name,
      role: (called) => `You are ${called}.`,
      persona: 'A test persona.',
    };
  }

  it('gives the lead Marimo and the next bot a different preset', async () => {
    const profiles = store();
    const lead = await profiles.activeProfile();
    expect(lead.avatar).toEqual({kind: 'preset', id: 'marimo'});

    const second = await profiles.create(seed('Writer'));
    expect(second.avatar).toEqual({kind: 'preset', id: 'sprout'});
  });

  it('gives an existing profile an icon without a migration write', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeProfileId: 'lead',
        profiles: [
          {
            id: 'lead',
            name: 'Marimo Bot',
            identity: 'You are an agent.',
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      }),
      'utf8',
    );

    const lead = await store().activeProfile();
    expect(lead.avatar).toEqual({kind: 'preset', id: 'marimo'});
  });

  it('stores a chosen preset, a custom marker and a clear', async () => {
    const profiles = store();
    const lead = await profiles.activeProfile();

    const chosen = await profiles.update(lead.id, {
      avatar: {kind: 'preset', id: 'wave'},
    });
    expect(chosen.avatar).toEqual({kind: 'preset', id: 'wave'});

    const custom = await profiles.update(lead.id, {
      avatar: {kind: 'custom', id: 'version-1'},
    });
    expect(custom.avatar).toEqual({kind: 'custom', id: 'version-1'});

    // A patch about something else leaves it alone.
    const renamed = await profiles.update(lead.id, {name: 'Other'});
    expect(renamed.avatar).toEqual({kind: 'custom', id: 'version-1'});

    // `null` is the third answer: back to the default for this roster position,
    // stored rather than left missing so the window and a restart agree.
    const cleared = await profiles.update(lead.id, {avatar: null});
    expect(cleared.avatar).toEqual({kind: 'preset', id: 'marimo'});
  });

  it('costs a malformed icon rather than the bot', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        activeProfileId: 'lead',
        profiles: [
          {
            id: 'lead',
            name: 'Marimo Bot',
            identity: 'You are an agent.',
            avatar: {kind: 'from-the-future', id: 'x'},
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      }),
      'utf8',
    );

    const lead = await store().activeProfile();
    expect(lead.name).toBe('Marimo Bot');
    expect(lead.avatar).toEqual({kind: 'preset', id: 'marimo'});
  });
});
