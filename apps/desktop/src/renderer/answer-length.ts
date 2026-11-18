/**
 * The three answer lengths, in the words the person is choosing between.
 *
 * Written once because two cards now offer the same three choices: the
 * companion's text length and the spoken-reply length. The sentences the model
 * actually gets live beside the agent, in `pet-turn.ts`; a pick-list labelled
 * with prompt text would be describing the implementation rather than the
 * choice.
 */
import type {CompanionAnswerLength} from '@marimo/protocol';

export const ANSWER_LENGTH_LABELS: Record<CompanionAnswerLength, string> = {
  brief: 'Brief — a few lines, the answer and nothing else',
  balanced: 'Balanced — as long as the question deserves',
  detailed: 'Detailed — the full answer here, not deferred to the window',
};
