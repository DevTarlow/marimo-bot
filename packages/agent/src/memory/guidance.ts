/**
 * What a small model is told about remembering the person.
 *
 * The long version of this lives in the built-in `memory` skill, but the v2
 * harness composer never carries that skill's body: its prompt context is the
 * memory file and the person's own advertised skills, and the capability
 * skills stayed behind with the legacy composer. A 2B model therefore had the
 * memory file in front of it and no instruction that a first-person fact
 * belonged in it — in a real session it answered "my name is tarlow" by saying
 * its own name was Marimo.
 *
 * This is deliberately short and imperative. It is paid for on every turn
 * where `update_memory` is offered, so it says the three things that decide
 * whether a detail survives: it is about them, write it before answering, and
 * never write a fact about yourself.
 */
export const REMEMBERING_GUIDANCE = [
  '- When the person tells you something about themselves — their name, where',
  '  they live, the people and animals in their life, what they like — that is',
  '  a fact about them, not about you. Call `update_memory` with section',
  '  "About the user" before you answer.',
  '- Never store facts about yourself: your name, what you are for, or the tools',
  '  you have. Memory is about the person and their work.',
  '- If the fact is already in the memory above, do not write it again. When',
  '  they correct one, pass the old bullet as "replaces" so both versions do',
  '  not stay.',
].join('\n');
