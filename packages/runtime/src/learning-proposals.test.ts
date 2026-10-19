/**
 * The learning queue: what the bot asks for, and what it was told not to ask
 * again.
 *
 * Two properties matter more than the storage. A proposal that is waiting must
 * not be added twice, because a queue that repeats itself is one nobody reads.
 * And a refusal must survive the card being removed, because the sentence the
 * model wrote changes while the capability it wanted does not.
 */
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  LearningProposalStore,
  LESSON_TTL_DAYS,
  lessonIsCurrent,
  MAX_LESSONS,
  MAX_PENDING_LEARNING,
  proposalSubject,
} from './learning-proposals.js';
import type {NewLearningProposal} from './learning-proposals.js';

function grant(
  overrides: Partial<Extract<NewLearningProposal, {kind: 'grant'}>> = {},
): NewLearningProposal {
  return {
    kind: 'grant',
    target: 'tool',
    name: 'read_file',
    profileId: 'profile-1',
    sessionId: 'session-1',
    reason: 'I could not open the file you asked about.',
    evidence: [],
    ...overrides,
  };
}

describe('the learning proposal store', () => {
  let dir: string;
  let file: string;
  let store: LearningProposalStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-learning-'));
    file = join(dir, 'learning', 'proposals.json');
    store = new LearningProposalStore({file});
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('starts with nothing waiting and nothing refused', async () => {
    const loaded = await store.load();
    expect(loaded.proposals).toEqual([]);
    expect(loaded.lessons).toEqual([]);
  });

  it('records a grant with an id and a time, and survives a restart', async () => {
    const after = await store.record(grant());
    expect(after.proposals).toHaveLength(1);
    expect(after.proposals[0]?.id).toBeTruthy();
    expect(after.proposals[0]?.createdAt).toBeTruthy();

    const reopened = await new LearningProposalStore({file}).load();
    expect(reopened.proposals[0]).toMatchObject({
      kind: 'grant',
      target: 'tool',
      name: 'read_file',
      profileId: 'profile-1',
    });
  });

  it('does not add the same capability twice while it is waiting', async () => {
    await store.record(grant());
    const after = await store.record(
      grant({reason: 'Said the same thing differently.'}),
    );
    expect(after.proposals).toHaveLength(1);
  });

  it('keeps two different capabilities apart', async () => {
    await store.record(grant());
    const after = await store.record(grant({name: 'web_search'}));
    expect(
      after.proposals.map((proposal) =>
        proposal.kind === 'grant' ? proposal.name : '',
      ),
    ).toEqual(['read_file', 'web_search']);
  });

  /*
   * The refusal is the part that makes the queue improve. Without it, removing
   * the card is all a dismissal does, and the next turn asks again in different
   * words — which is exactly the behaviour a person reads as not listening.
   */
  it('records a refusal as a lesson and keeps a re-ask out', async () => {
    const first = await store.record(grant());
    const id = first.proposals[0]?.id ?? '';
    const after = await store.remove(id, true);

    expect(after.proposals).toEqual([]);
    expect(after.lessons).toHaveLength(1);
    expect(after.lessons[0]?.summary).toBe('tool:read_file');

    const again = await store.record(grant());
    expect(again.proposals).toEqual([]);
  });

  /*
   * A refusal is not permanent. A bot that asked for a tool a year ago was a
   * different bot, and a lesson that can never expire turns one bad afternoon
   * into a silence the person cannot undo without finding a settings screen.
   */
  it('lets a refusal expire, so the bot may ask again later', async () => {
    const day = 86_400_000;
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const early = new LearningProposalStore({
      file,
      now: () => new Date(start),
    });
    const first = await early.record(grant());
    await early.remove(first.proposals[0]?.id ?? '', true);

    const soon = new LearningProposalStore({
      file,
      now: () => new Date(start + 30 * day),
    });
    expect((await soon.record(grant())).proposals).toEqual([]);

    const later = new LearningProposalStore({
      file,
      now: () => new Date(start + (LESSON_TTL_DAYS + 1) * day),
    });
    expect((await later.record(grant())).proposals).toHaveLength(1);
  });

  it('lets a refusal be cleared, so the bot may ask again', async () => {
    const first = await store.record(grant());
    await store.remove(first.proposals[0]?.id ?? '', true);
    await store.clearLessons();

    const again = await store.record(grant());
    expect(again.proposals).toHaveLength(1);
  });

  it('an acceptance removes the card and records no lesson', async () => {
    const first = await store.record(grant());
    const after = await store.remove(first.proposals[0]?.id ?? '', false);

    expect(after.proposals).toEqual([]);
    expect(after.lessons).toEqual([]);

    const again = await store.record(grant());
    expect(again.proposals).toHaveLength(1);
  });

  it('caps the queue by dropping the oldest', async () => {
    for (let index = 0; index < MAX_PENDING_LEARNING + 2; index += 1) {
      await store.record(grant({name: `tool_${String(index)}`}));
    }
    const after = await store.load();
    expect(after.proposals).toHaveLength(MAX_PENDING_LEARNING);
    expect(
      after.proposals[0]?.kind === 'grant' ? after.proposals[0].name : '',
    ).toBe('tool_2');
  });

  it('caps the refusals by dropping the oldest', async () => {
    for (let index = 0; index < MAX_LESSONS + 2; index += 1) {
      const after = await store.record(grant({name: `tool_${String(index)}`}));
      const id = after.proposals.at(-1)?.id ?? '';
      await store.remove(id, true);
    }
    const after = await store.load();
    expect(after.lessons).toHaveLength(MAX_LESSONS);
    expect(after.lessons[0]?.summary).toBe('tool:tool_2');
  });

  it('forgets a conversation without touching the refusals', async () => {
    await store.record(grant());
    await store.record(grant({name: 'web_search', sessionId: 'session-2'}));
    await store.forget('session-1');

    const after = await store.load();
    expect(
      after.proposals.map((proposal) =>
        proposal.kind === 'grant' ? proposal.name : '',
      ),
    ).toEqual(['web_search']);
  });

  it('forgets a bot entirely', async () => {
    await store.record(grant());
    await store.record(grant({profileId: 'profile-2'}));
    await store.forgetProfile('profile-1');

    const after = await store.load();
    expect(after.proposals.map((proposal) => proposal.profileId)).toEqual([
      'profile-2',
    ]);
  });

  /*
   * The file is a document the app owns. A newer one is refused rather than
   * parsed, and the write path must not overwrite a version it cannot read —
   * the same rule every other store follows.
   */
  it('refuses to write over a document from a newer build', async () => {
    await mkdir(join(dir, 'learning'), {recursive: true});
    await writeFile(
      file,
      `${JSON.stringify({version: 99, proposals: [], lessons: []})}\n`,
      'utf8',
    );
    await expect(store.record(grant())).rejects.toThrow(/newer/i);
    const raw = JSON.parse(await readFile(file, 'utf8')) as {version: number};
    expect(raw.version).toBe(99);
  });
});

describe('a lesson\'s age', () => {
  it('is current inside the window and expired outside it', () => {
    const lesson = {
      id: 'l1',
      profileId: 'p',
      kind: 'grant' as const,
      summary: 'tool:read_file',
      at: '2026-01-01T00:00:00.000Z',
    };
    const day = 86_400_000;
    const start = Date.parse(lesson.at);
    expect(lessonIsCurrent(lesson, new Date(start + 30 * day))).toBe(true);
    expect(
      lessonIsCurrent(lesson, new Date(start + (LESSON_TTL_DAYS + 1) * day)),
    ).toBe(false);
  });

  it('treats an unreadable date as expired rather than permanent', () => {
    expect(
      lessonIsCurrent(
        {
          id: 'l1',
          profileId: 'p',
          kind: 'grant',
          summary: 'tool:read_file',
          at: 'not a date',
        },
        new Date(),
      ),
    ).toBe(false);
  });
});

describe('proposal subjects', () => {
  it('names a grant by its capability rather than its wording', () => {
    expect(
      proposalSubject({
        kind: 'grant',
        target: 'connector',
        name: 'GitHub',
        profileId: 'p',
        sessionId: null,
        reason: 'x',
        evidence: [],
      }),
    ).toBe('connector:github');
  });

  it('names maintenance by its action and target', () => {
    expect(
      proposalSubject({
        kind: 'maintenance',
        action: 'disable-skill',
        target: 'Weekly Triage',
        profileId: 'p',
        sessionId: null,
        reason: 'x',
        evidence: [],
        summary: 'Unused.',
      }),
    ).toBe('disable-skill:weekly triage');
  });
});
