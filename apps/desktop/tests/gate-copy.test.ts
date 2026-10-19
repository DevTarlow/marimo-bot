/**
 * What an approval card says.
 *
 * The failure this protects against is not a broken button — it is a card that
 * asks "approve write_file?" in a vocabulary the person deciding has never been
 * shown, while the thing that matters (which file, and that it already exists)
 * is absent. ADK's hint is written for a model; this turns it into a sentence.
 */
import {describe, expect, it} from 'vitest';

import type {PendingGate} from '@marimo/protocol';

import {gateCopy} from '../src/renderer/gate-copy.js';

const ADK_BOILERPLATE =
  'Please approve or reject the tool call write_file() by responding with a ' +
  'FunctionResponse with an expected ToolConfirmation payload.';

function gate(overrides: Partial<PendingGate> = {}): PendingGate {
  return {
    callId: 'call-1',
    tool: 'write_file',
    args: {},
    hint: ADK_BOILERPLATE,
    askedAt: '2026-10-18T17:30:36.000Z',
    ...overrides,
  };
}

describe('gateCopy', () => {
  it('names the file and says it will be replaced, not the API call', () => {
    const copy = gateCopy(
      gate({
        args: {path: 'top-10-fruits.txt', content: 'TOP 10 FRUITS\n1. Banana'},
      }),
    );

    expect(copy.heading).toBe('Overwrite this existing file');
    expect(copy.primary).toBe('top-10-fruits.txt');
    expect(copy.note).toContain('bytes of new content');
    expect(copy.detail).toContain('1. Banana');
    expect(copy.detailLabel).toBe('Show the new contents');
    expect(copy.hint).toBeUndefined();
  });

  it('shows a command verbatim', () => {
    const copy = gateCopy(
      gate({tool: 'run_shell', args: {command: 'pnpm test', cwd: 'src'}}),
    );

    expect(copy.heading).toBe('Run this command in the workspace');
    expect(copy.primary).toBe('pnpm test');
    expect(copy.note).toContain('src');
  });

  it('keeps a hint that is already a sentence a person can decide on', () => {
    const hint =
      'Writer wants to overwrite this existing file: top-10-fruits.txt. ' +
      'Approving lets it carry on where it stopped.';
    const copy = gateCopy(gate({tool: 'ask_agent', hint, args: {agent: 'Writer'}}));

    expect(copy.heading).toBe('Hand work to another bot');
    expect(copy.hint).toBe(hint);
    // The delegated card is a sentence, not a second rendering of the arguments.
    expect(copy.primary).toBeUndefined();
  });

  it('never falls back to a JSON blob when the call has no known shape', () => {
    const copy = gateCopy(
      gate({tool: 'mystery_tool', args: {a: 1}, hint: ADK_BOILERPLATE}),
    );

    expect(copy.heading).toBe('Use mystery tool');
    expect(copy.primary).toContain('"a": 1');
    expect(copy.hint).toBeUndefined();
  });

  it('uses the summary when an older gate carries no hint at all', () => {
    const copy = gateCopy(
      gate({hint: '', args: {path: 'notes.md', content: 'hi'}}),
    );

    expect(copy.heading).toBe('Overwrite this existing file');
    expect(copy.primary).toBe('notes.md');
  });
});
