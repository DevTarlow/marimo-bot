/**
 * The composed system instruction.
 *
 * The profile's Role says what the agent is for; its Persona says who it is.
 * This module says how it works and what it currently remembers. The protocol
 * and the memory block are appended by the agent layer rather than stored in
 * settings, so a prompt saved by an older build still gets both.
 *
 * The one piece of the prompt the app does not own is `persona`: the person's
 * description of the character, the job and how they want to be spoken to. It
 * rides here, after the Role, because that is what it disagrees with.
 *
 * What is *in* the prompt is a property of the profile's tools, not of a second
 * list of switches. The operating protocol is unconditional, because the app's
 * own rules ship with the app; a capability skill rides along with the tools it
 * describes. That leaves `enabledSkills` naming the user's own skills and
 * nothing else, which is the one thing it can honestly mean.
 */
import {knowledgeSkill} from './knowledge-skill.js';
import {memorySkill} from './memory-skill.js';
import {reasoningSkill} from './reasoning-skill.js';
import type {Skill} from './types.js';

export {knowledgeSkill, memorySkill, reasoningSkill};
export type {Skill};

/** Every installed skill; `reasoning` renders as the operating protocol. */
export const SKILLS: readonly Skill[] = [
  reasoningSkill,
  memorySkill,
  knowledgeSkill,
];

/**
 * Names the app ships, which a user's skill may never take.
 *
 * Checked whatever the profile's tools are, rather than only against the skills
 * that happen to be carried: a profile can change between turns, and a saved
 * `memory` that was hidden while the memory tools were off would reappear as a
 * second `## memory` heading the moment they were switched back on.
 */
const BUILT_IN_NAMES: ReadonlySet<string> = new Set(
  SKILLS.map((skill) => skill.name),
);

export interface ComposeInstructionOptions {
  /** The profile's Role: what it is for, what it may claim, and its standards. */
  base: string;
  /**
   * The person's Persona: character, the job in their words, and how they want
   * to be spoken to.
   *
   * Its position is the reason it is a field rather than more text in `base`.
   * The conflicts that actually happen are with the Role's own defaults —
   * "be dry" against "be warm, I have had a day" — so the person's words have to
   * come *after* the Role to win them. They come before the protocol because the
   * protocol is the app's method rules and is meant to be unbeatable: a Persona
   * can ask for a different voice, not for a claim that a tool ran when it did
   * not, and not for a tool the profile was never given. Absent or blank means
   * they wrote none.
   */
  persona?: string;
  /** Current memory.md contents, or `''` when there is none. */
  memory: string;
  /**
   * Prompt text for this turn only, when there is any.
   *
   * Appended rather than folded into `base`, because the two have different
   * lifetimes: the identity is the profile and outlives the turn, and this is
   * whatever the surface that asked wanted — the desktop companion asking for a
   * shorter answer than the window. Being last is the point: an instruction that
   * arrives after the persona is the one a model follows where the two disagree.
   */
  instruction?: string;
  /**
   * Tool names this profile may use, or absent for a caller with no profile
   * concept at all.
   *
   * Absent is not "no tools" — it is "unrestricted", which is how a test or a
   * future CLI gets every skill. An empty array is a profile that can do nothing,
   * and it carries the protocol and none of the capability skills.
   */
  tools?: readonly string[];
  /**
   * Names of the user's own skills this profile may use, from `/learn` or the
   * editor.
   *
   * Absent means all of them, which is what a caller with no profile concept
   * wants; an empty array means this profile carries none of them. The built-in
   * skills are not named here and cannot be selected here — they follow `tools`.
   */
  userSkillNames?: string[];
  /**
   * The user's skills themselves, for `userSkillNames` to select from.
   *
   * Absent means the app has none, which is what a test with no skill store
   * wants. These are definitions, not a selection: which of them are available is
   * `userSkillNames`. Their bodies are advertised, not printed — `load_skill`
   * reads one when a task matches it.
   */
  userSkills?: readonly Skill[];
}

const EMPTY_MEMORY =
  '(nothing remembered yet — use update_memory to record facts worth keeping across sessions)';

/** Renders skills as `## name` blocks, in the order given. */
export function renderSkills(skills: readonly Skill[]): string {
  return skills
    .map(
      (skill) =>
        `## ${skill.name}\n${skill.description}\n\n${skill.instructions}`,
    )
    .join('\n\n');
}

/**
 * The user's skills, as a list of names with the line that says when to use
 * them.
 *
 * Deliberately not `renderSkills`: a user's procedure is loaded by `load_skill`
 * when a task matches, so its body is not paid for on every request. What this
 * list pays for is the sentence that lets the model recognise the match — which
 * is why the description cap exists and why it says *available* rather than
 * *these are your instructions*.
 */
export function renderAvailableSkills(skills: readonly Skill[]): string {
  const lines = skills.map(
    (skill) => `- ${skill.name}: ${skill.description}`,
  );
  return [
    'These are available, not loaded. Before doing a task one of them covers,',
    'call `load_skill` with its name and follow the procedure it returns.',
    '',
    ...lines,
  ].join('\n');
}

export function composeInstruction({
  base,
  persona,
  memory: memoryText,
  instruction,
  tools,
  userSkillNames,
  userSkills,
}: ComposeInstructionOptions): string {
  const reachable = SKILLS.filter((skill) => canCarry(skill, tools));
  const reasoning = reachable.find(
    (skill) => skill.name === reasoningSkill.name,
  );
  const memory = reachable.find((skill) => skill.name === memorySkill.name);
  /*
   * The built-in skills are the app's method rules and ride whole, because they
   * are what makes any answer follow the protocol. A user's skill is a procedure
   * for a task, so only its name and description are advertised here; the body
   * arrives through `load_skill` when the task actually calls for it.
   */
  const capabilitySkills = reachable.filter(
    (skill) => skill.name !== reasoningSkill.name,
  );
  const availableSkills = userSkillsFor(userSkillNames, userSkills ?? []);
  const memoryBody =
    memoryText.trim().length > 0 ? memoryText.trim() : EMPTY_MEMORY;
  const personaBody = persona?.trim() ?? '';

  const sections = [
    base.trim(),
    personaBody.length > 0 ? `# Persona\n\n${personaBody}` : '',
    reasoning ? `# Operating protocol\n\n${reasoning.instructions}` : '',
    capabilitySkills.length > 0
      ? `# Skills\n\n${renderSkills(capabilitySkills)}`
      : '',
    availableSkills.length > 0
      ? `# Available skills\n\n${renderAvailableSkills(availableSkills)}`
      : '',
    // Only an agent that can act on memory is given it: the block is otherwise a
    // set of facts from a system this profile was told to ignore, and an
    // instruction to use tools it may not have. It follows the memory skill,
    // which follows the memory tools.
    //
    // One heading for both files, because the model reads memory rather than a
    // filesystem: which layer belongs in which file is the memory skill's job to
    // say, and a second heading here would be the same fact in two places with
    // two chances to disagree.
    memory ? `# Long-term memory\n\n${memoryBody}` : '',
    // Last, and after everything else that has an opinion: this is the surface
    // the question was asked at, and it is the most specific instruction in the
    // prompt.
    instruction?.trim() ?? '',
  ];

  return sections
    .filter((section) => section.length > 0)
    .join('\n\n')
    .concat('\n');
}

/**
 * Whether a skill about tools belongs in this profile's prompt.
 *
 * "At least one" rather than "all": a capability skill is one piece of guidance
 * covering a group of tools, and requiring the whole group would drop the
 * workspace-first search advice from every profile that has not also granted an
 * arbitrary-URL fetch. Absent `tools` is the unrestricted caller, which gets
 * everything.
 */
function canCarry(skill: Skill, tools?: readonly string[]): boolean {
  return (
    skill.tools === undefined ||
    tools === undefined ||
    skill.tools.some((name) => tools.includes(name))
  );
}

/**
 * The user's skills this profile carries, in the order they were written.
 *
 * Filtered by `userSkillNames` rather than passing everything: a skill the user
 * switched off must not be advertised at all, or the model would call
 * `load_skill` for a name the library refuses. Even a carried skill costs only
 * its name and description here; the body is read on demand.
 */
function userSkillsFor(
  names: string[] | undefined,
  userSkills: readonly Skill[],
): Skill[] {
  const allowed = names === undefined ? undefined : new Set(names);
  return dedupeByName(
    userSkills.filter((skill) => !BUILT_IN_NAMES.has(skill.name)),
  ).filter((skill) => allowed === undefined || allowed.has(skill.name));
}

/**
 * One skill per name, first one wins.
 *
 * Two `## memory` headings in one prompt is the sort of thing a model reads as
 * two conflicting instructions. `save_skill` refuses a built-in name and the
 * store refuses a duplicate, so this is not the guard that matters — it is the
 * backstop for a hand-edited `skills.json`, where there is no one left to refuse
 * anything.
 */
function dedupeByName(skills: readonly Skill[]): Skill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.name)) {
      return false;
    }
    seen.add(skill.name);
    return true;
  });
}
