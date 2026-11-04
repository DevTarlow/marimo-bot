/**
 * The background catch-up, decided in the app layer.
 *
 * The claims are the gates rather than the embedding: a turn schedules one pass
 * after a quiet period, a machine with recall off does nothing, a machine that
 * has not downloaded the model is refused before an engine is started, and two
 * of the three cancellations — the user forgetting the index, and the app going
 * away — really cancel. `reindex` is replaced here, so no engine, model or
 * folder has to exist; what is being tested is the schedule, not the vectors.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {StoredSettings} from '@marimo/protocol';
import {defaultStoredSettings} from '@marimo/runtime';

import {RecallHost} from '../src/main/recall.js';

const ZEROS = {
  records: 0,
  chunks: 0,
  memory: 0,
  conversations: 0,
  media: 0,
};

describe('the recall background catch-up', () => {
  let userData: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    userData = await mkdtemp(join(process.cwd(), '.marimo-recall-refresh-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(userData, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function host(
    options: {enabled?: boolean; readOnly?: boolean} = {},
  ): RecallHost {
    const enabled = options.enabled ?? true;
    return new RecallHost({
      userData,
      personMemoryDir: join(userData, 'person'),
      readSettings: async (): Promise<Pick<StoredSettings, 'recall'>> => ({
        recall: {...defaultStoredSettings().recall, enabled},
      }),
      ...(options.readOnly === true ? {readOnly: true} : {}),
    });
  }

  /** The install gate, forced open so the schedule can be observed. */
  function allow(recall: RecallHost): void {
    vi.spyOn(
      recall as unknown as {canRefresh: () => Promise<boolean>},
      'canRefresh',
    ).mockResolvedValue(true);
  }

  it('brings the index forward once after a burst of turns', async () => {
    const recall = host();
    allow(recall);
    const reindex = vi.spyOn(recall, 'reindex').mockResolvedValue(ZEROS);

    recall.refreshSoon('profile', '/folder');
    recall.refreshSoon('profile', '/folder');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reindex).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(reindex).toHaveBeenCalledTimes(1);
    expect(reindex).toHaveBeenCalledWith('profile', '/folder');
  });

  it('keeps folders apart, because the indexes are apart', async () => {
    const recall = host();
    allow(recall);
    const reindex = vi.spyOn(recall, 'reindex').mockResolvedValue(ZEROS);

    recall.refreshSoon('profile', '/one');
    recall.refreshSoon('profile', '/two');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reindex.mock.calls.map((call) => call[1]).sort()).toEqual([
      '/one',
      '/two',
    ]);
  });

  it('does nothing in the read-only mode the runner uses', async () => {
    const recall = host({readOnly: true});
    const reindex = vi.spyOn(recall, 'reindex');

    recall.refreshSoon('profile');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reindex).not.toHaveBeenCalled();
  });

  it('does nothing when the user has recall switched off', async () => {
    const recall = host({enabled: false});
    const reindex = vi.spyOn(recall, 'reindex');

    recall.refreshSoon('profile');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reindex).not.toHaveBeenCalled();
  });

  it('refuses before an engine is started when the model is not on disk', async () => {
    const recall = host();
    const reindex = vi.spyOn(recall, 'reindex');

    recall.refreshSoon('profile');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reindex).not.toHaveBeenCalled();
  });

  it('cancels a queued pass when the index is forgotten', async () => {
    const recall = host();
    const reindex = vi.spyOn(recall, 'reindex').mockResolvedValue(ZEROS);

    recall.refreshSoon('profile');
    await recall.forget('profile');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reindex).not.toHaveBeenCalled();
  });

  it('cancels a queued pass when the app stops', async () => {
    const recall = host();
    const reindex = vi.spyOn(recall, 'reindex').mockResolvedValue(ZEROS);

    recall.refreshSoon('profile');
    await recall.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reindex).not.toHaveBeenCalled();
  });

  /*
   * The turn hook resolves the conversation's folder asynchronously, so a turn
   * that ended a moment before quit reaches `refreshSoon` after the shutdown has
   * run. It must not arm a timer behind it and start an engine for a window that
   * is gone.
   */
  it('refuses a pass that arrives after the app has stopped', async () => {
    const recall = host();
    const reindex = vi.spyOn(recall, 'reindex').mockResolvedValue(ZEROS);

    await recall.stop();
    recall.refreshSoon('profile');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reindex).not.toHaveBeenCalled();
  });
});
