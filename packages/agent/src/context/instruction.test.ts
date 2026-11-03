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

  /*
   * The list is the model's own reference. A 2B model read it back to the
   * person as "the tools available in this turn are…" after an ordinary
   * thank-you, so the instruction next to the list says what it is for.
   */
  it('says the list is for the model, not for the person', () => {
    const text = composeHarnessInstruction(harness(), {tools: [read, write]});

    expect(text).toContain('This list is for you');
    expect(text).toContain('do not read it back to the person');
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
      'To change what is inside a file, call `write_file`: read it first',
    );
    expect(text).toContain('Do not tell the person to edit it');
  });

  it('does not claim a read tool the turn does not have', () => {
    const text = composeHarnessInstruction(harness(), {tools: [write]});

    expect(text).toContain(
      'To change what is inside a file, call `write_file`: send the',
    );
    expect(text).not.toContain('read it first');
  });

  it('never adds the write note without write_file', () => {
    const text = composeHarnessInstruction(harness(), {tools: [read]});

    expect(text).not.toContain('To change what is inside a file');
  });

  /*
   * The rule is above the write rule on purpose. A model told first that a
   * change is a write reads a rename as a change and writes a copy under the new
   * name, which is the failure `move_file` exists to prevent.
   */
  it('puts the rename rule before the write rule', () => {
    const text = composeHarnessInstruction(harness(), {
      tools: [
        read,
        write,
        {name: 'move_file', description: 'Move one file inside the workspace.'},
      ],
    });

    expect(text).toContain('To rename or move a file, call `move_file`');
    expect(text).toContain('leaves the old file where it was');
    expect(text.indexOf('To rename or move a file')).toBeLessThan(
      text.indexOf('To change what is inside a file'),
    );
  });

  it('says removing a file is a delete_file call, not a shell command', () => {
    const text = composeHarnessInstruction(harness(), {
      tools: [
        read,
        {
          name: 'delete_file',
          description: 'Delete one file inside the workspace.',
        },
      ],
    });

    expect(text).toContain(
      'A request to remove a file is a `delete_file` call',
    );
    expect(text).toContain('Do not use a shell command to delete');
  });

  it('never adds the move or delete note without its tool', () => {
    const text = composeHarnessInstruction(harness(), {tools: [read, write]});

    expect(text).not.toContain('To rename or move a file');
    expect(text).not.toContain('A request to remove a file');
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

/*
 * The memory file used to be introduced as "your own notebook", which a 2B model
 * read as facts about itself: in the session that prompted this, "my name is
 * tarlow" was answered with "My name is Marimo Bot, not Tarlow". The file is
 * about the person, and the instruction that says so is only carried when the
 * turn can write to it.
 */
describe('remembering the person', () => {
  const update = {
    name: 'update_memory',
    description: 'Remember a durable fact.',
  };

  it('frames memory as facts about the person, not the agent', () => {
    const text = composeHarnessInstruction(harness(), {
      memory: '## About the user\n- Name: Tarlow',
      tools: [read],
    });

    expect(text).toContain(
      'What you remember about the person and their work:',
    );
    expect(text).toContain('not about you');
    expect(text).not.toContain('your own notebook');
  });

  it('says how to remember a personal detail when the turn can write', () => {
    const text = composeHarnessInstruction(harness(), {
      tools: [read, update],
    });

    expect(text).toContain('# Remembering');
    expect(text).toContain('"About the user"');
    expect(text).toContain('Never store facts about yourself');
    expect(text).toContain('pass the old bullet as "replaces"');
  });

  it('does not carry the remembering guidance without update_memory', () => {
    const text = composeHarnessInstruction(harness(), {
      memory: '## About the user\n- Name: Tarlow',
      tools: [read],
    });

    expect(text).not.toContain('# Remembering');
    expect(text).not.toContain('Never store facts about yourself');
  });

  it('puts remembering after the memory it is about and before the tools', () => {
    const text = composeHarnessInstruction(harness(), {
      memory: '## About the user\n- Name: Tarlow',
      tools: [read, update],
    });

    expect(text.indexOf('What you remember')).toBeLessThan(
      text.indexOf('# Remembering'),
    );
    expect(text.indexOf('# Remembering')).toBeLessThan(
      text.indexOf('# Tools you have'),
    );
  });
});
