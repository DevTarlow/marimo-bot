/**
 * What the agent is told about the moment, in words.
 *
 * This is the half of the "reflex" idea that survives contact with the app's own
 * rule: a reply in the transcript has to be one the model produced, so nothing
 * here answers anybody. It hands the model the facts a person would already have
 * if they were in the room — what time it is, whether this is the first thing
 * said in a while or a continuing exchange, which window asked, and what was
 * attached — and lets the model be the one who greets, reacts and matches tone.
 *
 * Two rules shape it.
 *
 * **Facts, not tasks.** The block is appended last in the composed instruction,
 * where a model follows an instruction most literally, so it says out loud that
 * none of it is a request. Without that line a model reads "it is 09:41 on a
 * Tuesday" as something to act on, and a greeting becomes a status report.
 *
 * **Facts the app actually knows.** Every line is derived from state the runtime
 * holds: the process clock, the session index, and the message itself. Nothing is
 * inferred about how the user feels, because a wrong guess about somebody's mood
 * is worse than no guess — and it would be a claim the app cannot back.
 *
 * A surface that is not a person typing gets nothing. A scheduled job and a
 * Discord mention pass no `origin`, and telling a job "this is the first thing
 * they have said in this conversation" would simply be false.
 */
import {readAttachedFiles} from '@marimo/protocol';

/** How recently a message still reads as the same exchange rather than a return. */
const SAME_EXCHANGE_MS = 2 * 60 * 1000;

export interface TurnContextFacts {
  /** The clock when the turn started, as the app's process reads it. */
  now: Date;
  /** Which surface asked. Anything else means there is no person to address. */
  origin?: 'window' | 'pet' | undefined;
  /**
   * When this conversation last had activity, read *before* the turn began.
   *
   * Absent when there is nothing to say: a brand-new conversation, a session
   * index that cannot be read, or a timestamp that does not parse. An absent
   * value drops the line rather than making one up.
   */
  lastActivity?: Date | undefined;
  /** Whether this is the first thing said in this conversation. */
  firstExchange: boolean;
  /** The message as the user sent it, so an attachment block can be read out of it. */
  text: string;
}

/**
 * The block for one turn, or `undefined` when there is nothing to say.
 *
 * Total and pure: a turn is being assembled when this runs, and no fact about the
 * moment is worth ending a turn over.
 */
export function turnContext(facts: TurnContextFacts): string | undefined {
  if (facts.origin !== 'window' && facts.origin !== 'pet') {
    return undefined;
  }

  const lines = [
    '- It is ' +
      `${DAY_NAMES[facts.now.getDay()] ?? 'today'}, ` +
      `${facts.now.getDate()} ${MONTH_NAMES[facts.now.getMonth()] ?? ''}, ` +
      `and the local time is ${clock(facts.now)} (${partOfDay(facts.now)}).`.trim(),
  ];

  const elapsed = describeElapsed(facts.now, facts.lastActivity);
  if (facts.firstExchange) {
    lines.push('- This is the first thing they have said in this conversation.');
  } else if (elapsed !== undefined) {
    lines.push(`- The conversation last had activity ${elapsed}.`);
  }

  lines.push(
    facts.origin === 'pet'
      ? '- They asked this at the floating companion.'
      : '- They asked this in the main window.',
  );

  const attached = readAttachedFiles(facts.text).files;
  if (attached.length > 0) {
    lines.push(
      `- They attached ${attached.map((file) => file.path).join(', ')}. ` +
        'Those files are why they wrote, and the paths are relative to the ' +
        'folder you work in.',
    );
  }

  return [
    '# Right now',
    '',
    'Facts about the moment this was asked. None of them is a request on its own,',
    'and none of them is about how they feel — answer the person, not the clock.',
    '',
    ...lines,
  ].join('\n');
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Local wall-clock time, 24-hour, zero-padded. */
function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
}

function partOfDay(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) {
    return 'very late at night';
  }
  if (hour < 12) {
    return 'in the morning';
  }
  if (hour < 17) {
    return 'in the afternoon';
  }
  if (hour < 22) {
    return 'in the evening';
  }
  return 'late at night';
}

/**
 * How long ago, in words, or `undefined` for an exchange that is still going.
 *
 * Rounded rather than precise on purpose: "about four hours ago" is what a person
 * would say, and a minute-accurate number invites the model to do arithmetic
 * about somebody's day that nobody asked for. A clock that has moved backwards —
 * a suspend, a timezone change, an edited index — reports nothing rather than a
 * negative age.
 */
function describeElapsed(
  now: Date,
  lastActivity: Date | undefined,
): string | undefined {
  if (lastActivity === undefined) {
    return undefined;
  }
  const ms = now.getTime() - lastActivity.getTime();
  if (!Number.isFinite(ms) || ms < SAME_EXCHANGE_MS) {
    return undefined;
  }

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return minutes < 10
      ? `about ${minutes} minutes ago`
      : `about ${Math.round(minutes / 5) * 5} minutes ago`;
  }

  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) {
    return hours === 1 ? 'about an hour ago' : `about ${hours} hours ago`;
  }

  const days = Math.round(ms / 86_400_000);
  if (days <= 1) {
    return 'yesterday';
  }
  if (days < 30) {
    return `about ${days} days ago`;
  }
  return 'over a month ago';
}
