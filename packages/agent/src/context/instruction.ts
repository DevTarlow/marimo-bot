/**
 * Turning a frozen harness into the instruction the model sees.
 *
 * This is the only place the prompt is assembled, and it reads the spec plus the
 * turn's own context. That is the point of freezing the spec before a turn: two
 * calls for the same turn cannot see different profiles, and a test can assert
 * the exact text a turn ran under.
 *
 * Memory is carried whole here; retrieval narrows it later, in the same layer
 * that owns the file. A skill is advertised by name and one line, never carried
 * as a body: `load_skill` reads the body when a task matches.
 *
 * The tool list is the one layer taken from the definitions the adapter actually
 * wraps rather than from the frozen spec, so a grant the turn cannot use is not
 * named. A small model reads the list in prose; the tool JSON alone is not
 * enough, and this session's `write_file` denial is the evidence.
 */
import type {HarnessSpec} from '../harness/spec.js';
import {REMEMBERING_GUIDANCE} from '../memory/guidance.js';

export interface HarnessSkillSummary {
  name: string;
  description: string;
}

export interface HarnessPromptContext {
  memory?: string;
  skills?: readonly HarnessSkillSummary[];
  /**
   * The tools this turn can actually call, by name and one line.
   *
   * Supplied by the adapter from the definitions it wraps, not read from
   * `harness.tools.grants`: a grant the turn cannot use (no Space, no service)
   * is not offered, and a prompt that named it would advertise a capability the
   * turn does not have. Each description is already bounded by the caller.
   */
  tools?: ReadonlyArray<{name: string; description: string}>;
  /**
   * Capabilities this bot does not have and could ask for.
   *
   * Only filled when `request_tool` is granted, and never with `run_shell`: a
   * list of things the bot may request is a list of things the person may be
   * asked to approve, and putting the shell on it would make the refusal a
   * matter of the model's judgement.
   */
  catalogue?: ReadonlyArray<{name: string; description: string}>;
  /** Text for this turn only: the surface that asked, not the bot. */
  instruction?: string;
}

export function composeHarnessInstruction(
  harness: HarnessSpec,
  context: HarnessPromptContext = {},
): string {
  const sections: string[] = [];

  sections.push(
    ['How you work:', ...harness.contract.map((rule) => `- ${rule}`)].join(
      '\n',
    ),
  );

  sections.push(
    `You are ${harness.identity.name}.${
      harness.identity.role.trim().length === 0
        ? ''
        : `\n\n${harness.identity.role.trim()}`
    }`,
  );

  const persona = harness.identity.persona?.trim();
  if (persona !== undefined && persona.length > 0) {
    sections.push(`How the person wants you to be:\n\n${persona}`);
  }

  if (harness.workspaceRoot !== undefined) {
    sections.push(
      `You are working in the folder ${harness.workspaceRoot}. Every file tool ` +
        'is confined to it; a path that leaves it is refused, and that refusal ' +
        'is an answer rather than something to work around.',
    );
  }

  const tools = context.tools ?? [];

  const memory = context.memory?.trim();
  if (memory !== undefined && memory.length > 0) {
    sections.push(
      `What you remember about the person and their work:\n\n${memory}\n\n` +
        'These are facts about the person and their work, not about you. A ' +
        'fact that is out of date is worth correcting with update_memory; a ' +
        'fact the person asked you to forget is worth dropping.',
    );
  }

  /*
   * Only when the turn can actually write memory. The built-in memory skill
   * carried this in the old composer, but the v2 prompt context is memory plus
   * the person's own skills — so a 2B model had the file and no instruction
   * that a first-person fact belonged in it.
   */
  if (tools.some((tool) => tool.name === 'update_memory')) {
    sections.push(`# Remembering\n\n${REMEMBERING_GUIDANCE}`);
  }

  const skills = context.skills ?? [];
  if (skills.length > 0) {
    sections.push(
      [
        'Skills you may load. The line says when one is useful; the steps are ' +
          'read with load_skill only when a task matches:',
        ...skills.map((skill) => `- ${skill.name} — ${skill.description}`),
      ].join('\n'),
    );
  }

  if (tools.length > 0) {
    const canWrite = tools.some((tool) => tool.name === 'write_file');
    const canRead = tools.some((tool) => tool.name === 'read_file');
    const canMove = tools.some((tool) => tool.name === 'move_file');
    const canDelete = tools.some((tool) => tool.name === 'delete_file');
    sections.push(
      [
        '# Tools you have',
        '',
        'These are callable in this turn. If the request needs one, call it',
        'rather than telling the person you cannot. A greeting needs none of',
        'them. This list is for you: do not read it back to the person unless',
        'they ask what you can do.',
        '',
        ...tools.map((tool) =>
          tool.description.trim().length === 0
            ? `- ${tool.name}`
            : `- ${tool.name} — ${tool.description.trim()}`,
        ),
        ...(canMove
          ? [
              '',
              'To rename or move a file, call `move_file` with the path it has ' +
                'now and the path it should have. This is the only way to ' +
                'rename: writing the text under the new name leaves the old ' +
                'file where it was, so that is not a rename even when the ' +
                'person used the word.',
            ]
          : []),
        ...(canWrite
          ? [
              '',
              canRead
                ? 'To change what is inside a file, call `write_file`: read it ' +
                  'first when it already exists, then send the complete new ' +
                  'text. Do not tell the person to edit it themselves.'
                : 'To change what is inside a file, call `write_file`: send the ' +
                  'complete new text. Do not tell the person to edit it ' +
                  'themselves.',
            ]
          : []),
        ...(canDelete
          ? [
              '',
              'A request to remove a file is a `delete_file` call. It asks the ' +
                'person first, and the file is gone for good afterwards, so name ' +
                'the file you are deleting. Do not use a shell command to delete.',
            ]
          : []),
      ].join('\n'),
    );
  }

  const catalogue = context.catalogue ?? [];
  if (catalogue.length > 0) {
    sections.push(
      [
        'Capabilities you do not have. If a task needs one, `request_tool` can',
        'ask the person for it — they decide, and you do not have it until they',
        'do. Do not use this list to narrate a capability you were not given:',
        ...catalogue.map((entry) => `- ${entry.name} — ${entry.description}`),
      ].join('\n'),
    );
  }

  const instruction = context.instruction?.trim();
  if (instruction !== undefined && instruction.length > 0) {
    sections.push(instruction);
  }

  return sections.join('\n\n');
}
