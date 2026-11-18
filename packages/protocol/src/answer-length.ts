/**
 * How long an answer should be, in the three sizes the app offers.
 *
 * Its own module because two blocks now use the same three choices: the
 * companion's text answers and the spoken replies. Two copies of the enum would
 * be two places for a fourth size to be added to one and not the other, and the
 * instruction that turns the choice into prompt text reads the same value.
 */
import {z} from 'zod';

export const COMPANION_ANSWER_LENGTHS = [
  'brief',
  'balanced',
  'detailed',
] as const;

export const companionAnswerLengthSchema = z.enum(COMPANION_ANSWER_LENGTHS);

export type CompanionAnswerLength = z.infer<typeof companionAnswerLengthSchema>;
