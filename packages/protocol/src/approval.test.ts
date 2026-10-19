import {describe, expect, it} from 'vitest';

import {meaningfulHint, summarizeApproval} from './approval.js';

describe('summarizeApproval', () => {
  it('shows a shell command verbatim', () => {
    const preview = summarizeApproval('run_shell', {command: 'pnpm test'});
    expect(preview.headline).toContain('Run this command');
    expect(preview.primary).toBe('pnpm test');
    expect(preview.detail).toBeUndefined();
  });

  it('mentions a shell working directory when one is set', () => {
    const preview = summarizeApproval('run_shell', {
      command: 'ls',
      cwd: 'src',
    });
    expect(preview.note).toContain('src');
  });

  it('shows the path, the size, and a preview for an overwrite', () => {
    const preview = summarizeApproval('write_file', {
      path: 'notes/todo.md',
      content: 'buy milk',
    });
    expect(preview.headline).toContain('Overwrite');
    expect(preview.primary).toBe('notes/todo.md');
    expect(preview.note).toBe('8 bytes of new content will replace it');
    expect(preview.detail).toBe('buy milk');
    expect(preview.detailLabel).toBe('Show the new contents');
  });

  it('clips a long overwrite preview', () => {
    const preview = summarizeApproval('write_file', {
      path: 'big.txt',
      content: Array.from(
        {length: 500},
        (_value, index) => `line ${index}`,
      ).join('\n'),
    });
    expect(preview.detail?.split('\n').length).toBeLessThanOrEqual(21);
    expect(preview.detail?.endsWith('…')).toBe(true);
  });

  it('falls back to pretty JSON for an unknown tool', () => {
    const preview = summarizeApproval('mystery_tool', {a: 1, b: 'two'});
    expect(preview.headline).toBe('Use mystery tool');
    expect(preview.primary).toContain('"a": 1');
  });

  it('survives arguments that are not an object', () => {
    expect(summarizeApproval('run_shell', undefined).primary).toBe('');
    expect(summarizeApproval('write_file', 'nonsense').primary).toBe(
      'nonsense',
    );
  });

  it('counts bytes rather than characters', () => {
    const preview = summarizeApproval('write_file', {
      path: 'x.txt',
      content: 'é',
    });
    expect(preview.note).toBe('2 bytes of new content will replace it');
  });
});

describe('meaningfulHint', () => {
  it('drops ADK boilerplate written for the model', () => {
    expect(
      meaningfulHint(
        'Please approve or reject the tool call run_shell() by responding with a FunctionResponse with an expected ToolConfirmation payload.',
      ),
    ).toBe(false);
    expect(meaningfulHint('   ')).toBe(false);
  });

  it('keeps a hint a human can use', () => {
    expect(meaningfulHint('This deletes the build directory.')).toBe(true);
  });
});

/**
 * The skill approval, which is the one card whose decision is *reading* rather
 * than recognising: what is being approved is prompt text the agent will follow
 * from the next request onwards, so the instructions have to be on the card.
 */
describe('summarizeApproval for save_skill', () => {
  const args = {
    name: 'weekly-inbox-triage',
    description: 'Sort the inbox every Monday.',
    instructions: '1. Read the unread mail.\n2. Group it by sender.',
  };

  it('shows the instructions, and names the skill underneath', () => {
    const preview = summarizeApproval('save_skill', args);

    expect(preview.headline).toBe('Save this skill and switch it on');
    expect(preview.primary).toContain('Read the unread mail');
    expect(preview.note).toContain('weekly-inbox-triage');
    expect(preview.note).toContain('Sort the inbox every Monday.');
  });

  it('bounds a skill that would not fit on a card', () => {
    const preview = summarizeApproval('save_skill', {
      ...args,
      instructions: Array.from(
        {length: 200},
        (_, index) => `line ${index}`,
      ).join('\n'),
    });

    expect(preview.primary.split('\n').length).toBeLessThan(30);
  });

  it('falls back to the arguments when there is nothing to show', () => {
    const preview = summarizeApproval('save_skill', {});
    expect(preview.headline).toBe('Save this skill and switch it on');
    expect(preview.primary.length).toBeGreaterThan(0);
  });
});

/**
 * The gates that are not a file or a command. These exist because a card headed
 * "Run create_job" told the person nothing about what they were agreeing to —
 * every one of these is a decision with a real consequence behind it.
 */
describe('summarizeApproval for the other gated tools', () => {
  it('names a job and says when it runs, in words', () => {
    const preview = summarizeApproval('create_job', {
      name: 'Morning inbox digest',
      description: 'Read the unread mail and post a summary.',
      schedules: ['0 9 * * 1-5'],
    });

    expect(preview.headline).toBe('Schedule this job');
    expect(preview.primary).toBe('Morning inbox digest');
    expect(preview.note).toContain('09:00');
    expect(preview.note).not.toContain('0 9 * * 1-5');
    expect(preview.detail).toContain('Read the unread mail');
    expect(preview.detailLabel).toBe('Show the instruction it runs');
  });

  it('says what a job change will touch', () => {
    const preview = summarizeApproval('update_job', {
      jobId: 'job-1',
      enabled: false,
      name: 'New name',
    });

    expect(preview.headline).toBe('Change a scheduled job');
    expect(preview.primary).toBe('job-1');
    expect(preview.note).toContain('name');
    expect(preview.note).toContain('paused');
  });

  it('says that deleting a job is permanent', () => {
    const preview = summarizeApproval('delete_job', {jobId: 'job-1'});
    expect(preview.note).toContain('for good');
  });

  it('shows a Discord message and where it is going', () => {
    const preview = summarizeApproval('send_discord_message', {
      text: 'Standup in five.',
      channel: 'general',
    });

    expect(preview.headline).toBe('Post this message on Discord');
    expect(preview.primary).toBe('Standup in five.');
    expect(preview.note).toBe('Channel: #general');
  });

  it('names the bot being handed work', () => {
    const preview = summarizeApproval('ask_agent', {
      agent: 'Writer',
      task: 'Write the top ten fruits to a file.\nThen report back.',
    });

    expect(preview.headline).toBe('Hand work to another bot');
    expect(preview.primary).toBe('Writer');
    expect(preview.note).toBe('Write the top ten fruits to a file.');
  });
});
