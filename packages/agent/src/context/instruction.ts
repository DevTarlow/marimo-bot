/**
 * Turning a frozen harness into the instruction the model sees.
 *
 * This is the only place the prompt is assembled, and it reads only the spec.
 * That is the point of freezing the spec before a turn: two calls for the same
 * turn cannot see different profiles, and a test can assert the exact text a
 * turn ran under.
 *
 * Memory, the user's skills and capability guidance are not here yet. They land
 * with their stores in Phase 2; this is the stable contract, the bot's identity
 * and the person's own words, which every turn needs from the first day.
 */
import type {HarnessSpec} from '../harness/spec.js';

export function composeHarnessInstruction(harness: HarnessSpec): string {
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

  return sections.join('\n\n');
}
