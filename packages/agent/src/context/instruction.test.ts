/**
 * The prompt's tool list.
 *
 * The failure this exists for is on disk: a 2B model that had `write_file`
 * granted, and had already called `read_file`, told the person it had no tool to
 * edit a file because the only file tool the prose named was `read_file`. The
 * list has to follow the definitions the adapter actually offers, not the
 * profile's grants, or the opposite failure appears: a prompt advertising a tool
 * the turn cannot call.
 */
import {describe, expect, it} from 'vitest';

import {resolveHarness} from '../harness/resolve.js';
import type {HarnessAppDefaults} from '../harness/spec.js';
import {composeHarnessInstruction} from './instruction.js';

const app: HarnessAppDefaults = {
  model: {provider: 'local', model: 'lfm3-omni-2b'},
  allowPrivateNetworkFetch: false,
  learning: {mode: 'propose', retainTraces: false},
};

function harness(enabledTools: string[] = ['read_file', 'write_file']) {
  return resolveHarness({
    profile: {
      id: 'writer',
      name: 'Writer',
      role: 'Write for the person.',
      enabledTools,
      enabledSkills: [],
    },
    app,
    version: 1,
    workspaceRoot: '/space',
  });
}

const read = {
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace.',
};
const write = {
  name: 'write_file',
  description:
    'Create, edit or replace a UTF-8 text file inside the workspace; replacing an existing file asks the person first.',
};

describe('composeHarnessInstruction tool list', () => {
  it('lists exactly the tools it is given, in order', () => {
    const text = composeHarnessInstruction(harness(), {tools: [read, write]});

    expect(text).toContain('# Tools you have');
    expect(text.indexOf(`- ${read.name} —`)).toBeLessThan(
      text.indexOf(`- ${write.name} —`),
    );
    expect(text).toContain(`- write_file — ${write.description}`);
    expect(text).not.toContain('web_search');
    expect(text).not.toContain('list_dir — ');
  });

  it('says nothing about tools when the turn has none', () => {
    const text = composeHarnessInstruction(harness(), {tools: []});

    expect(text).not.toContain('# Tools you have');
  });

  it('renders a tool with no description as its name', () => {
    const text = composeHarnessInstruction(harness(), {
      tools: [{name: 'mcp_notes_search', description: '   '}],
    });

    expect(text).toContain('- mcp_notes_search');
    expect(text).not.toContain('mcp_notes_search — ');
  });

  it('says a request to change a file is a write_file call', () => {
    const text = composeHarnessInstruction(harness(), {tools: [read, write]});

    expect(text).toContain(
      'A request to change a file is a `write_file` call: read it first',
    );
    expect(text).toContain('Do not tell the person to edit it');
  });

  it('does not claim a read tool the turn does not have', () => {
    const text = composeHarnessInstruction(harness(), {tools: [write]});

    expect(text).toContain(
      'A request to change a file is a `write_file` call: send the',
    );
    expect(text).not.toContain('read it first');
  });

  it('never adds the write note without write_file', () => {
    const text = composeHarnessInstruction(harness(), {tools: [read]});

    expect(text).not.toContain('A request to change a file');
  });

  /*
   * The layers have different jobs. A tools section after the turn instruction
   * would be the last thing the model reads and would compete with the surface's
   * "answer briefly"; a section after the catalogue would make "capabilities you
   * do not have" the frame the tools are read in. It sits between them.
   */
  it('puts the tools after the skills and before the catalogue', () => {
    const text = composeHarnessInstruction(harness(), {
      memory: 'They like short answers.',
      skills: [{name: 'style', description: 'House style.'}],
      tools: [read, write],
      catalogue: [{name: 'run_shell', description: 'Run a command.'}],
      instruction: 'Answer briefly.',
    });

    expect(text.indexOf('# Tools you have')).toBeGreaterThan(
      text.indexOf('style'),
    );
    expect(text.indexOf('# Tools you have')).toBeLessThan(
      text.indexOf('Capabilities you do not have'),
    );
    expect(text.indexOf('# Tools you have')).toBeLessThan(
      text.indexOf('Answer briefly.'),
    );
  });

  it('carries the contract rule that a listed tool is available', () => {
    const text = composeHarnessInstruction(harness(), {tools: [read]});

    expect(text).toContain(
      'A tool on your list is available even if you have not called it yet',
    );
  });
});
