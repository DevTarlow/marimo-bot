/**
 * Where the agent's suggestions wait for an answer.
 *
 * The watermark is what most of this covers, because it decides whether the
 * feature is usable at all: a review that forgot how far it had read would
 * re-propose the same facts every time the app went quiet, and a queue that
 * refills itself with things already dismissed is one nobody opens.
 */
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  MAX_DISMISSED,
  MAX_PENDING_PROPOSALS,
  MemoryProposalStore,
} from './memory-proposals.js';
import type {NewProposal} from './memory-proposals.js';

function proposal(overrides: Partial<NewProposal> = {}): NewProposal {
  return {
    sessionId: 'session-1',
    profileId: 'profile-1',
    section: 'Notes',
    text: 'Prefers tabs over spaces.',
    reason: 'they said so',
    ...overrides,
  };
}

describe('the proposal store', () => {
  let dir: string;
  let file: string;
  let store: MemoryProposalStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-proposals-'));
    file = join(dir, 'memory-proposals.json');
    store = new MemoryProposalStore({file});
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('starts with nothing waiting and nothing reviewed', async () => {
    const file = await store.load();
    expect(file.proposals).toEqual([]);
    expect(file.reviewed).toEqual({});
  });

  it('records a proposal with an id and a time', async () => {
    const after = await store.record('session-1', 4, [proposal()]);

    expect(after.proposals).toHaveLength(1);
    expect(after.proposals[0]?.id).toBeTruthy();
    expect(after.proposals[0]?.createdAt).toBeTruthy();
    expect(after.proposals[0]?.text).toBe('Prefers tabs over spaces.');
  });

  it('survives a restart', async () => {
    await store.record('session-1', 4, [proposal()]);
    const reopened = await new MemoryProposalStore({file}).load();
    expect(reopened.proposals).toHaveLength(1);
  });

  /*
   * `replaces` is what carries a correction from the reviewer all the way to the
   * moment the user accepts it — the only point at which the old bullet can be
   * removed. Dropping it in storage would turn every correction into a duplicate
   * fact, silently, on the next restart.
   */
  it('carries the bullet a correction replaces, across a restart', async () => {
    await store.record('session-1', 4, [
      proposal({text: 'Uses pnpm now.', replaces: 'Uses npm.'}),
    ]);

    const reopened = await new MemoryProposalStore({file}).load();
    expect(reopened.proposals[0]?.replaces).toBe('Uses npm.');
  });

  /*
   * Evidence is what makes a proposal checkable after a restart. The quote was
   * verified against the transcript when the review ran; if the store dropped it,
   * the window would show a fact with only the model's own reason beside it,
   * which is the thing the quote exists to outrank.
   */
  it('carries the words a fact came from, across a restart', async () => {
    await store.record('session-1', 4, [
      proposal({evidence: {quote: 'I prefer tabs.', turnId: 'turn-1'}}),
    ]);

    const reopened = await new MemoryProposalStore({file}).load();
    expect(reopened.proposals[0]?.evidence).toEqual({
      quote: 'I prefer tabs.',
      turnId: 'turn-1',
    });
  });

  it('carries no evidence for a proposal written before the field existed', async () => {
    await store.record('session-1', 4, [proposal()]);

    const reopened = await new MemoryProposalStore({file}).load();
    expect(reopened.proposals[0]).not.toHaveProperty('evidence');
  });

  it('carries no replaces for an ordinary proposal', async () => {
    await store.record('session-1', 4, [proposal()]);

    const reopened = await new MemoryProposalStore({file}).load();
    expect(reopened.proposals[0]).not.toHaveProperty('replaces');
  });

  /*
   * The downgrade case, and the reason this document stays at version 2. An older
   * build parses the file as current, strips the field it does not know, and
   * keeps the proposal — which degrades to appending rather than replacing. The
   * alternative, a version bump, would make that build treat the whole file as
   * unreadable and quarantine everything the user had not answered yet.
   */
  it('loads a version 2 file whose proposals have no replaces', async () => {
    await writeFile(
      file,
      `${JSON.stringify(
        {
          version: 2,
          proposals: [
            {
              id: 'p1',
              sessionId: null,
              section: 'Notes',
              text: 'Prefers tabs.',
              reason: 'they said so',
              profileId: 'profile-1',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          reviewed: {},
          dismissed: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const loaded = await new MemoryProposalStore({file}).load();
    expect(loaded.proposals).toHaveLength(1);
    expect(loaded.proposals[0]?.text).toBe('Prefers tabs.');
  });

  describe('the watermark', () => {
    it('starts at zero for a conversation nobody has reviewed', async () => {
      expect(await store.reviewedUpTo('session-9')).toBe(0);
    });

    it('remembers how far it read', async () => {
      await store.record('session-1', 12, []);
      expect(await store.reviewedUpTo('session-1')).toBe(12);
    });

    /*
     * The behaviour this exists to prevent. "I looked and found nothing" is the
     * answer most of the time, and not recording it means looking again on every
     * idle moment forever — spending tokens to be told nothing, repeatedly.
     */
    it('moves even when nothing was proposed', async () => {
      await store.record('session-1', 7, []);
      expect(await store.reviewedUpTo('session-1')).toBe(7);
      expect((await store.load()).proposals).toEqual([]);
    });

    it('keeps each conversation apart', async () => {
      await store.record('session-1', 3, []);
      await store.record('session-2', 9, []);
      expect(await store.reviewedUpTo('session-1')).toBe(3);
      expect(await store.reviewedUpTo('session-2')).toBe(9);
    });

    it('survives a restart, which is the whole point of storing it', async () => {
      await store.record('session-1', 11, []);
      expect(
        await new MemoryProposalStore({file}).reviewedUpTo('session-1'),
      ).toBe(11);
    });
  });

  describe('the queue', () => {
    /*
     * The reviewer filters against memory.md; this filters against the queue,
     * which is the other way the same fact arrives twice — a conversation
     * reviewed, then reviewed again from a slightly different watermark.
     */
    it('does not add the same fact twice', async () => {
      await store.record('session-1', 1, [proposal()]);
      const after = await store.record('session-1', 2, [proposal()]);
      expect(after.proposals).toHaveLength(1);
    });

    it('keeps the same fact for two different agents', async () => {
      // Two agents may legitimately remember the same thing; they are separate
      // memories and separate system prompts.
      await store.record('session-1', 1, [proposal()]);
      const after = await store.record('session-1', 2, [
        proposal({profileId: 'profile-2'}),
      ]);
      expect(after.proposals).toHaveLength(2);
    });

    it('drops the oldest when it is full', async () => {
      for (let index = 0; index < MAX_PENDING_PROPOSALS + 3; index += 1) {
        await store.record('session-1', index, [
          proposal({text: `Fact number ${String(index)}.`}),
        ]);
      }
      const after = await store.load();

      expect(after.proposals).toHaveLength(MAX_PENDING_PROPOSALS);
      // The newest survive: they are about the conversation the user just had.
      expect(after.proposals.at(-1)?.text).toBe(
        `Fact number ${String(MAX_PENDING_PROPOSALS + 2)}.`,
      );
      expect(after.proposals[0]?.text).toBe('Fact number 3.');
    });

    it('removes one, whether it was accepted or dismissed', async () => {
      const withOne = await store.record('session-1', 1, [proposal()]);
      const id = withOne.proposals[0]?.id ?? '';

      const after = await store.remove(id);

      expect(after.proposals).toEqual([]);
      // The watermark stays: dismissing is an answer, not a reason to look again.
      expect(after.reviewed['session-1']).toBe(1);
    });

    it('ignores a removal for something already gone', async () => {
      await expect(store.remove('no-such-id')).resolves.toMatchObject({
        proposals: [],
      });
    });

    it('forgets a deleted conversation, watermark and all', async () => {
      await store.record('session-1', 5, [proposal()]);
      // A different fact, so the queue's own dedupe does not collapse the two —
      // which is what it correctly does for the *same* fact from two places.
      await store.record('session-2', 5, [
        proposal({sessionId: 'session-2', text: 'Works in Rust.'}),
      ]);

      const after = await store.forget('session-1');

      expect(after.proposals.map((entry) => entry.sessionId)).toEqual([
        'session-2',
      ]);
      expect(after.reviewed['session-1']).toBeUndefined();
      expect(after.reviewed['session-2']).toBe(5);
    });

    /*
     * What a removed bot leaves behind otherwise is a suggestion nothing can
     * show — and a refusal that would silence a *new* bot only if the ids were
     * ever reused, which they are not.
     */
    it('forgets a removed bot, suggestions and refusals alike', async () => {
      await store.record('session-1', 5, [proposal()]);
      await store.record('session-2', 5, [
        proposal({
          sessionId: 'session-2',
          profileId: 'profile-2',
          text: 'Works in Rust.',
        }),
      ]);
      await store.dismiss({profileId: 'profile-1', text: 'Has a cat.'});
      await store.dismiss({profileId: 'profile-2', text: 'Prefers dark mode.'});

      const after = await store.forgetProfile('profile-1');

      expect(after.proposals.map((entry) => entry.profileId)).toEqual([
        'profile-2',
      ]);
      expect(after.dismissed.map((entry) => entry.profileId)).toEqual([
        'profile-2',
      ]);
      // The other bot's watermark is not this removal's to reset.
      expect(after.reviewed['session-2']).toBe(5);
    });
  });

  describe('the file', () => {
    it('writes a versioned document', async () => {
      await store.record('session-1', 1, [proposal()]);
      const written = JSON.parse(await readFile(file, 'utf8')) as {
        version: number;
        dismissed: unknown[];
      };
      /*
       * The version is what makes an older build refuse this file instead of
       * parsing it, dropping the one field it does not know and writing the
       * refusals away — which is why adding `dismissed` moved it.
       */
      expect(written.version).toBe(2);
      expect(written.dismissed).toEqual([]);
    });

    /*
     * The window still opens on a file it cannot read. Only the write path is
     * strict — a lenient read plus a careless write is how data disappears, so
     * the write is the half that has to refuse.
     */
    it('reads an unreadable file as empty rather than refusing to start', async () => {
      await writeFile(file, 'not json at all', 'utf8');
      expect(await new MemoryProposalStore({file}).load()).toMatchObject({
        proposals: [],
      });
    });

    it('refuses a file from a newer build', async () => {
      await writeFile(file, JSON.stringify({version: 99}), 'utf8');
      await expect(new MemoryProposalStore({file}).load()).rejects.toThrow(
        /newer version/u,
      );
    });

    it('refuses to write over a file from a newer build', async () => {
      const future = JSON.stringify({version: 99});
      await writeFile(file, future, 'utf8');

      await expect(store.record('session-1', 1, [proposal()])).rejects.toThrow(
        /newer version/u,
      );
      expect(await readFile(file, 'utf8')).toBe(future);
    });

    it('leaves no half-file behind', async () => {
      await store.record('session-1', 1, [proposal()]);
      const {readdir} = await import('node:fs/promises');
      const leftovers = (await readdir(dir)).filter((name) =>
        name.endsWith('.tmp'),
      );
      expect(leftovers).toEqual([]);
    });
  });

  /*
   * What the user said no to.
   *
   * The half of the review loop that the queue alone cannot hold: a proposal that
   * is merely removed leaves no trace, and a fact the user refused is then
   * indistinguishable from one nobody has proposed yet.
   */
  describe('refusals', () => {
    it('records a refusal with the profile it belongs to', async () => {
      const after = await store.dismiss({
        profileId: 'profile-1',
        text: 'Scans their receipts every Sunday.',
      });

      expect(after.dismissed).toHaveLength(1);
      expect(after.dismissed[0]?.profileId).toBe('profile-1');
      expect(after.dismissed[0]?.text).toBe(
        'Scans their receipts every Sunday.',
      );
      expect(after.dismissed[0]?.at).toBeTruthy();
    });

    /*
     * The same fact phrased with different spacing is the same refusal. Compared
     * exactly as `isNewProposal` compares against memory, because the two are the
     * same judgement about the same sentence.
     */
    it('counts one refusal once, however it is spelled', async () => {
      await store.dismiss({profileId: 'p', text: 'Prefers tabs over spaces'});
      const after = await store.dismiss({
        profileId: 'p',
        text: '  prefers   TABS over spaces ',
      });

      expect(after.dismissed).toHaveLength(1);
    });

    it('keeps one profile from silencing another', async () => {
      await store.dismiss({profileId: 'work', text: 'Has a dog named Bramble'});
      const after = await store.dismiss({
        profileId: 'personal',
        text: 'Has a dog named Bramble',
      });

      expect(after.dismissed).toHaveLength(2);
    });

    it('ignores a refusal with nothing in it', async () => {
      const after = await store.dismiss({profileId: 'p', text: '   '});
      expect(after.dismissed).toEqual([]);
    });

    /*
     * Removing a proposal and recording the refusal happen in one write, because
     * a crash between the two would leave the suggestion gone and its refusal
     * unrecorded — and the next review would propose it again, which is the
     * behaviour refusals exist to stop.
     */
    it('records the refusal in the same write that removes the proposal', async () => {
      const recorded = await store.record('session-1', 1, [proposal()]);
      const id = recorded.proposals[0]?.id ?? '';

      const after = await store.remove(id, {
        profileId: 'profile-1',
        text: 'Prefers tabs over spaces.',
      });

      expect(after.proposals).toEqual([]);
      expect(after.dismissed.map((entry) => entry.text)).toEqual([
        'Prefers tabs over spaces.',
      ]);
    });

    it('records nothing when a proposal is accepted', async () => {
      const recorded = await store.record('session-1', 1, [proposal()]);
      const after = await store.remove(recorded.proposals[0]?.id ?? '');

      expect(after.dismissed).toEqual([]);
    });

    /*
     * The oldest go first. A refusal is a statement about the reviewer's
     * judgement at the time, and the one from a phase the user has moved past is
     * the one most likely to be wrong now.
     */
    it('drops the oldest refusals past the cap', async () => {
      for (let index = 0; index < MAX_DISMISSED + 5; index += 1) {
        await store.dismiss({profileId: 'p', text: `fact ${String(index)}`});
      }
      const after = await store.load();

      expect(after.dismissed).toHaveLength(MAX_DISMISSED);
      expect(after.dismissed[0]?.text).toBe('fact 5');
      expect(after.dismissed.at(-1)?.text).toBe(
        `fact ${String(MAX_DISMISSED + 4)}`,
      );
    });

    it('forgets every refusal when asked', async () => {
      await store.dismiss({profileId: 'p', text: 'one'});
      await store.dismiss({profileId: 'q', text: 'two'});

      const after = await store.clearDismissed();
      expect(after.dismissed).toEqual([]);
      // And the queue is untouched: clearing refusals is not clearing the list
      // of things still waiting for an answer.
      expect((await store.load()).dismissed).toEqual([]);
    });

    /*
     * A record that rebuilt the document instead of carrying it would make every
     * review silently undo every refusal the user had given — the failure mode
     * that is invisible from the window, because the queue still works.
     */
    it('carries the refusals through a review', async () => {
      await store.dismiss({profileId: 'p', text: 'Prefers tabs over spaces'});
      const after = await store.record('session-1', 9, [proposal()]);

      expect(after.dismissed).toHaveLength(1);
      expect(after.reviewed['session-1']).toBe(9);
    });
  });

  /*
   * The file moved to version 2 to carry the refusals, and the upgrade is the
   * reason it did.
   */
  describe('upgrading a version 1 file', () => {
    it('adds the refusals and rewrites the version', async () => {
      const version1 = JSON.stringify({
        version: 1,
        proposals: [],
        reviewed: {'session-1': 3},
      });
      await writeFile(file, version1, 'utf8');

      const loaded = await store.load();
      expect(loaded.version).toBe(2);
      expect(loaded.dismissed).toEqual([]);
      // What was there is still there: a migration that lost the watermark would
      // make the next review re-read the whole conversation.
      expect(loaded.reviewed['session-1']).toBe(3);

      /*
       * And the next write is version 2 on disk. A file that was merely tolerated
       * would still look like version 1, which is the state an older build
       * overwrites.
       */
      await store.record('session-2', 1, []);
      const written = JSON.parse(await readFile(file, 'utf8')) as {
        version: number;
      };
      expect(written.version).toBe(2);
    });
  });
});
