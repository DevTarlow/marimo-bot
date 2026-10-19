import {describe, expect, it} from 'vitest';

import type {ToolContext} from './tool-contract.js';
import {
  proposePolicyTool,
  requestConnectorTool,
  requestToolTool,
} from './learning-tools.js';

function context(
  request: (input: {
    target: 'tool' | 'connector';
    name: string;
    reason: string;
    evidence?: string;
  }) => Promise<{ok: boolean; result: string}>,
): ToolContext {
  return {
    workspaceRoot: '/tmp',
    signal: new AbortController().signal,
    learning: {
      request,
      proposePolicy: async () => ({ok: true, result: 'Proposed.'}),
    },
  };
}

describe('request_tool', () => {
  it('records a proposal and says the person decides', async () => {
    const asked: unknown[] = [];
    const result = await requestToolTool.execute(
      {name: 'read_file', reason: 'I could not open the file.'},
      context(async (input) => {
        asked.push(input);
        return {ok: true, result: 'Asked the person for read_file.'};
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: 'Asked the person for read_file.',
    });
    expect(asked).toEqual([
      {target: 'tool', name: 'read_file', reason: 'I could not open the file.'},
    ]);
  });

  it('refuses the shell by name, before it reaches the store', async () => {
    let asked = false;
    const result = await requestToolTool.execute(
      {name: 'run_shell', reason: 'I need to run a command.'},
      context(async () => {
        asked = true;
        return {ok: true, result: 'nope'};
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.result).toContain('never requested');
    expect(asked).toBe(false);
  });

  it('needs a name and a reason', async () => {
    const result = await requestToolTool.execute(
      {name: '  ', reason: 'x'},
      context(async () => ({ok: true, result: 'nope'})),
    );
    expect(result.ok).toBe(false);

    const noReason = await requestToolTool.execute(
      {name: 'read_file', reason: ''},
      context(async () => ({ok: true, result: 'nope'})),
    );
    expect(noReason.ok).toBe(false);
  });

  it('proposes a policy change through the same inbox', async () => {
    const asked: unknown[] = [];
    const result = await proposePolicyTool.execute(
      {
        maxToolCalls: 10,
        reason: 'The turn kept running out of calls.',
      },
      {
        workspaceRoot: '/tmp',
        signal: new AbortController().signal,
        learning: {
          request: async () => ({ok: true, result: 'nope'}),
          proposePolicy: async (input) => {
            asked.push(input);
            return {ok: true, result: 'Proposed.'};
          },
        },
      },
    );

    expect(result).toEqual({ok: true, result: 'Proposed.'});
    expect(asked).toEqual([
      {
        patch: {maxToolCalls: 10},
        reason: 'The turn kept running out of calls.',
      },
    ]);
  });

  it('refuses a policy proposal that changes nothing', async () => {
    const result = await proposePolicyTool.execute(
      {reason: 'Something feels wrong.'},
      {
        workspaceRoot: '/tmp',
        signal: new AbortController().signal,
        learning: {
          request: async () => ({ok: true, result: 'nope'}),
          proposePolicy: async () => ({ok: true, result: 'Proposed.'}),
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.result).toContain('at least one setting');
  });

  it('answers with a sentence when the turn has no inbox', async () => {
    const result = await requestToolTool.execute(
      {name: 'read_file', reason: 'I could not open the file.'},
      {workspaceRoot: '/tmp', signal: new AbortController().signal},
    );
    expect(result.ok).toBe(false);
    expect(result.result).toContain('cannot ask for capabilities');
  });
});

describe('request_connector', () => {
  it('asks for a connector, not a tool', async () => {
    const asked: unknown[] = [];
    const result = await requestConnectorTool.execute(
      {name: 'github', reason: 'The repository is on GitHub.'},
      context(async (input) => {
        asked.push(input);
        return {ok: true, result: 'Asked the person for github.'};
      }),
    );

    expect(result.ok).toBe(true);
    expect(asked).toEqual([
      {
        target: 'connector',
        name: 'github',
        reason: 'The repository is on GitHub.',
      },
    ]);
  });
});
