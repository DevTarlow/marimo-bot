/**
 * Noticing what is worth remembering.
 *
 * The agent already has `update_memory`, and it calls it when it thinks to. This
 * is the other half: after a conversation has moved on, something reads back
 * what was said and proposes the durable facts the agent did not stop to write
 * down. A preference mentioned in passing, a decision that was settled, the way
 * a project is laid out.
 *
 * Four decisions shape it, and each is the difference between a feature and a
 * nuisance.
 *
 * **It proposes; the caller writes.** Long-term memory is injected into every
 * future system prompt, so a wrong entry is not a wrong answer once — it is a
 * wrong belief the agent carries into every later conversation. That is why the
 * check happens before the write, and why nothing reaches here without a quote
 * from the conversation. The caller applies what survives this function, because
 * the person can see every fact and forget one afterwards; waiting on an
 * approval for each is a second queue they did not ask for.
 *
 * **It reviews only what it has not seen.** A watermark records how far the
 * review has read, so an idle conversation is not re-read and re-proposed every
 * time the app goes quiet.
 *
 * **A malformed answer proposes nothing.** The model's reply is untrusted input
 * like any other, and the failure mode of guessing at a half-parsed fact is a
 * confident sentence in memory that nobody wrote.
 *
 * **The rubric says what to leave out**, not just what to include. A model asked
 * for "facts worth remembering" will happily propose that the user said hello.
 * The exclusions are what make the queue short enough to read.
 */
import {z} from 'zod';

import {splitMemory} from './memory-store.js';
import {CANONICAL_SECTIONS, renderSectionGuide} from './sections.js';

/** One fact the reviewer thinks is worth keeping. */
export interface MemoryProposal {
  /** Where it would go in `memory.md`. */
  section: string;
  /** The fact, as it would be written. */
  text: string;
  /** Why it is worth keeping, in the model's words, for the user to judge by. */
  reason: string;
  /**
   * The existing bullet this one supersedes, when it is a correction.
   *
   * Absent for the ordinary case, which is a new fact. Present when the
   * reviewer recognised that what it is proposing replaces something already
   * remembered — and it is worth carrying all the way to the moment the user
   * accepts, because that is the only point at which the old bullet can be
   * removed cleanly. Appending instead leaves both versions in memory, which is
   * the state the memory skill spends a paragraph warning against.
   */
  replaces?: string;
  /**
   * The words in the conversation this fact came from.
   *
   * Required on anything the review records. A proposal's `reason` is the
   * model's own explanation and costs nothing to invent; a quote is checked
   * against the transcript, so a fact nobody said cannot reach the queue by
   * being confidently worded. The turn id is filled in when the quote can be
   * located, which is what lets the window say *where* in the conversation the
   * claim came from rather than only that it did.
   */
  evidence?: {quote: string; turnId?: string};
}

/** The most proposals one review may produce. */
export const MAX_PROPOSALS = 5;

/** How much of a conversation one review may read. */
export const MAX_REVIEW_CHARS = 24_000;

/**
 * How many bullets of existing memory the reviewer is shown.
 *
 * Not the whole file: memory has a 64 KiB cap and the reviewer's job is
 * recognition, not recall. Forty is more than one conversation is likely to
 * touch, and the count is reported so the prompt does not read as if it were
 * everything.
 */
export const MAX_EXISTING_BULLETS = 40;

/** How many characters of existing bullets the reviewer is shown. */
export const MAX_EXISTING_CHARS = 3_000;

/**
 * The longest section name a proposal may carry.
 *
 * A named section the file already has is always allowed, so this is a bound
 * rather than a whitelist — but it is derived from the canonical vocabulary
 * instead of being a literal, because a name too long to propose is a layer the
 * reviewer silently cannot use.
 */
export const MAX_SECTION_CHARS = Math.max(
  48,
  ...CANONICAL_SECTIONS.map((section) => section.name.length),
);

/**
 * The layer the JSON example uses.
 *
 * A model copies the shape of the example, so this has to be a real layer and
 * not the fallback — an example written into `Notes` silently undoes the
 * layering the prompt just asked for. Exported so the test can assert the two
 * agree rather than restating the name.
 */
export const PROPOSAL_EXAMPLE_SECTION = 'Preferences and tone';

/**
 * The shapes a proposal may take.
 *
 * `text` is bounded because it becomes a line in a file that is injected into
 * every future prompt: a model that answers with an essay would otherwise put
 * the essay in the system prompt forever. The bound is generous enough for a
 * real fact and short enough that five of them are still smaller than the
 * conversation they came from.
 */
const proposalSchema = z.object({
  section: z.string().trim().min(1).max(MAX_SECTION_CHARS),
  text: z.string().trim().min(3).max(400),
  reason: z.string().trim().max(200),
  /*
   * The existing bullet to replace, when this is a correction.
   *
   * Optional rather than required-with-an-empty-default, because the common case
   * is a new fact and a required field would make every proposal carry a
   * meaningless empty string into the queue — where a reader cannot tell "no
   * correction" from "a correction whose target was lost".
   */
  replaces: z.string().trim().max(400).optional(),
  /**
   * A phrase copied from the conversation.
   *
   * Optional in the parse and required by `runReview`, on purpose: an answer
   * without one is a well-formed JSON object that cannot be trusted, and the
   * parse is also used to prove what a model *wrote*. The filter that matters
   * lives below, where the quote is checked against the transcript.
   */
  quote: z.string().trim().min(1).max(300).optional(),
});

const answerSchema = z.object({
  proposals: z.array(proposalSchema).max(MAX_PROPOSALS),
});

/**
 * What to ask, given a conversation.
 *
 * Written as a list of exclusions as much as inclusions. "Anything worth
 * remembering" produces a queue nobody reads; naming what does *not* count is
 * what keeps it to the things a person would actually want written down.
 *
 * The sections are named rather than left to the model, because memory is
 * layered: a fact proposed into `Notes` is one the agent will read in the same
 * pile as everything else, and the layer it belongs in is exactly what decides
 * whether it is still relevant. The example therefore uses a real section
 * instead of the fallback — a model copies the shape of the example.
 */
export function reviewPrompt(
  conversation: string,
  refused: readonly RefusedFact[] = [],
  memory = '',
  corrections: readonly Correction[] = [],
): string {
  const existing = existingMemoryList(memory);
  return [
    'You are reviewing a conversation between a user and their desktop agent,',
    "to find facts worth keeping in the agent's long-term memory.",
    '',
    'Long-term memory is shown to the agent at the start of every future',
    'conversation. Propose something only if it would still be true and still',
    'useful in a month, and only if it is about the *user* or their work.',
    '',
    'Worth proposing:',
    '- a preference they stated, especially one they had to correct the agent on',
    '- a decision that was settled, and the reason if they gave one',
    '- how their project or machine is set up, when it is not obvious',
    '- something they asked the agent to always or never do',
    '',
    'Do not propose:',
    '- anything the user already knows, or that is already in the memory below',
    '- the content of the task itself, or what the agent did to complete it',
    '- pleasantries, or that the conversation happened at all',
    '- anything you inferred rather than were told',
    '- secrets, keys, passwords or tokens — never these, under any framing',
    ...(refused.length === 0
      ? []
      : [
          '',
          /*
           * Named as a block rather than as more bullets, because the reason is
           * different from the rest of the list: this is not a rule about what
           * matters, it is a record of this person's answers. A model that
           * understands *why* keeps applying it to paraphrases.
           */
          'The user has already been shown these and said no. Do not propose them',
          'again, and do not propose the same fact in different words:',
          ...refused.map((entry) => `- ${entry.text}`),
        ]),
    ...(existing.text.length === 0
      ? []
      : [
          '',
          /*
           * The list is here so a *correction* can be recognised as one. The
           * filter that stops a repeat is code (`isNewProposal`), and the prompt
           * names the rule only because a model told what not to send produces
           * less to filter — but no substring test can tell that "we use pnpm
           * now" supersedes "we use npm", and only the model can. Saying how many
           * were left out matters: a model told it is looking at all of memory
           * would conclude a fact it cannot see does not exist.
           */
          'Memory already holds the bullets below. Do not propose any of them',
          'again. If what you are proposing *replaces* one of them — a preference',
          'they changed, a fact they corrected — set "replaces" to that bullet',
          'exactly as it appears here, and leave "replaces" as "" for a new fact.' +
            (existing.hidden > 0
              ? ` (${String(existing.hidden)} further bullets are not shown; if none` +
                ' of the ones above is the fact you mean, propose yours as new.)'
              : ''),
          existing.text,
        ]),
    ...(corrections.length === 0
      ? []
      : [
          '',
          /*
           * The strongest evidence this prompt gets. A correction is the user
           * having already done the work of saying what is true — where the rest
           * of the conversation has to be read for hints, this is stated. It is
           * also the only place the agent learns that an *answer* was wrong
           * rather than that a fact was unwanted, which is why it is a block of
           * its own rather than more refusals.
           */
          'The user marked these answers as wrong. Where they said what was',
          'right, that is a fact to propose — stated by them, in their words, and',
          'the reason it belongs in memory:',
          ...corrections.map((entry) =>
            entry.text.length > 0
              ? `- they said: "${entry.text}" (about this answer: "${entry.excerpt}")`
              : `- (no correction given, about this answer: "${entry.excerpt}")`,
          ),
        ]),
    '',
    'Put each proposal in the layer it belongs in:',
    renderSectionGuide(),
    '',
    'Those are the common layers, not the only ones: a section the memory file',
    'already has is fine to use, and "Notes" is the fallback when nothing fits.',
    '',
    'Every proposal must carry "quote": a short phrase copied word for word',
    'from the conversation that supports the fact. Do not paraphrase it, do not',
    "join two sentences with an ellipsis, and do not quote the agent's own",
    'reasoning. A proposal whose quote cannot be found in the conversation is',
    'discarded before it is remembered.',
    '',
    'Answer with JSON only, no prose around it:',
    '{"proposals":[{"section":"' +
      PROPOSAL_EXAMPLE_SECTION +
      '","text":"...","reason":"...","replaces":"","quote":"..."}]}',
    '',
    'At most 5. An empty list is the right answer for most conversations.',
    '',
    '--- conversation ---',
    conversation,
  ].join('\n');
}

/**
 * The bullets memory holds, as prompt text, with what was left out.
 *
 * Reads the same document the store writes — the merged one — so a fact the user
 * can see in `read_memory` is a fact the reviewer can be told about. When the cap
 * bites, the count travels with the text rather than being dropped: a model that
 * believes it has seen all of memory concludes that a fact it cannot find is not
 * there, and proposes the duplicate this whole block exists to prevent.
 */
export function existingMemoryList(memory: string): {
  text: string;
  shown: number;
  hidden: number;
} {
  const bullets: Array<{section: string; text: string}> = [];
  for (const block of splitMemory(memory)) {
    const section = block.heading ?? '';
    for (const line of block.lines) {
      const match = /^\s*[-*]\s+(.+?)\s*$/u.exec(line);
      const text = match?.[1] ?? '';
      if (text.length > 0) {
        bullets.push({section, text});
      }
    }
  }
  if (bullets.length === 0) {
    return {text: '', shown: 0, hidden: 0};
  }

  const lines: string[] = [];
  let used = 0;
  for (const bullet of bullets.slice(0, MAX_EXISTING_BULLETS)) {
    const line =
      bullet.section.length > 0
        ? `- [${bullet.section}] ${bullet.text}`
        : `- ${bullet.text}`;
    if (used + line.length + 1 > MAX_EXISTING_CHARS) {
      break;
    }
    used += line.length + 1;
    lines.push(line);
  }

  return {
    text: lines.join('\n'),
    shown: lines.length,
    hidden: bullets.length - lines.length,
  };
}

/**
 * Reads the model's answer.
 *
 * Never throws. A review that cannot be understood proposes nothing, because the
 * alternative — salvaging half a sentence — writes something nobody said into a
 * file that shapes every future conversation.
 *
 * JSON is asked for and extracted leniently: models wrap it in prose or a fenced
 * block often enough that refusing those would make the feature look broken. The
 * *content* is still validated strictly.
 */
export function parseProposals(answer: string): MemoryProposal[] {
  const json = extractJson(answer);
  if (json === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  const result = answerSchema.safeParse(parsed);
  return result.success ? result.data.proposals.map(withoutEmptyReplaces) : [];
}

/**
 * Drops a `replaces` the model left as an empty string.
 *
 * The JSON example shows the key with `""` because the alternative is an example
 * that omits it, and a model copies the shape of the example — so the empty
 * string is what "no correction" looks like on the wire. Downstream it has to be
 * absence rather than emptiness: `undefined` is "this is a new fact", and `''`
 * would reach `removeTarget` and be reported as a correction that matched
 * nothing, which is a different sentence to the user.
 */
function withoutEmptyReplaces(proposal: {
  section: string;
  text: string;
  reason: string;
  replaces?: string | undefined;
  quote?: string | undefined;
}): MemoryProposal {
  const {replaces, quote, ...rest} = proposal;
  const evidence =
    quote === undefined || quote.length === 0 ? undefined : quote;
  return {
    ...rest,
    ...(replaces === undefined || replaces.length === 0 ? {} : {replaces}),
    ...(evidence === undefined ? {} : {evidence: {quote: evidence}}),
  };
}

/**
 * Whether a quote really occurs in the text the reviewer was given.
 *
 * Case- and whitespace-insensitive, and no more lenient than that. A model that
 * re-cased a sentence still copied it; one that rewrote it did not, and the
 * difference is the whole point of asking. The quotes around it are stripped
 * because a model asked for a phrase often supplies the quotation marks too.
 */
function quoteAppears(quote: string, text: string): boolean {
  const wanted = comparable(
    quote.replaceAll(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/gu, ''),
  );
  if (wanted.length < 3) {
    return false;
  }
  return comparable(text).includes(wanted);
}

function comparable(value: string): string {
  return value.toLowerCase().replaceAll(/\s+/gu, ' ').trim();
}

/**
 * The turn a quote came from, when the events still carry one.
 *
 * A review reads events that were rendered, and the turn id is on the ones that
 * have it. Looking it up here rather than in the caller keeps the evidence and
 * the proposal in one write: a proposal whose quote is in event 12 but whose
 * turn id says 11 is worse than no turn id at all.
 */
function turnOfQuote(
  quote: string,
  events: readonly ReviewEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const text = (event?.content?.parts ?? [])
      .filter((part) => part.thought !== true)
      .map((part) => part.text ?? '')
      .join(' ');
    if (
      text.length > 0 &&
      quoteAppears(quote, text) &&
      event?.turnId !== undefined
    ) {
      return event.turnId;
    }
  }
  return undefined;
}

/**
 * The JSON object inside whatever the model actually wrote.
 *
 * Scans for the outermost braces rather than matching a pattern, so a fenced
 * block, a leading sentence and a trailing apology all work. Strings inside are
 * skipped, because a `}` inside a proposed fact would otherwise end the object
 * early and hand the parser a truncated one.
 */
function extractJson(answer: string): string | undefined {
  const start = answer.indexOf('{');
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < answer.length; index += 1) {
    const character = answer[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return answer.slice(start, index + 1);
      }
    }
  }

  // Unbalanced: the answer was cut off, which a streaming reply often is.
  return undefined;
}

/**
 * Whether a proposal is one the memory does not already hold.
 *
 * Compared case-insensitively on collapsed whitespace, because the same fact
 * phrased with different spacing is the same fact and proposing it again is how
 * a queue stops being read.
 */
export function isNewProposal(
  proposal: MemoryProposal,
  existing: string,
): boolean {
  const normalise = (value: string): string =>
    value.toLowerCase().replaceAll(/\s+/gu, ' ').trim();
  const target = normalise(proposal.text);
  if (target.length === 0) {
    return false;
  }
  /*
   * A correction is not a repeat. The bullet it resembles is the one it removes
   * when the user accepts, so filtering it here would silently turn "we use pnpm
   * now, not npm" into no proposal at all — and the contradiction the user was
   * correcting would stay in memory forever.
   *
   * The cost is that a model could name a `replaces` to dodge this filter. That
   * is visible rather than silent: the accept path reports whether the target was
   * actually found, and a target that matches nothing means the old bullet is
   * still there, which is the sentence the user reads.
   */
  if ((proposal.replaces ?? '').trim().length > 0) {
    return true;
  }
  const haystack = normalise(existing);
  if (haystack.includes(target)) {
    return false;
  }
  /*
   * And the other direction, coarsely: a proposal that *contains* an existing
   * line is usually the same fact with more context attached. Compared by line,
   * so a long memory file does not swallow every short proposal.
   */
  return !haystack
    .split('\n')
    .map(normalise)
    .some((line) => line.length > 20 && target.includes(line));
}

/** One stored event, as this file reads it. */
export interface ReviewEvent {
  author?: string;
  /** The turn the words belong to, when the caller kept it. */
  turnId?: string;
  content?: {parts?: Array<{text?: string; thought?: boolean}>};
}

/**
 * A fact the user refused, as the reviewer reads it.
 *
 * The text alone: the profile it belongs to and when it was refused are the
 * store's business, and a reviewer that could see the timestamps would be tempted
 * to weigh them, which is not a judgement this prompt asks for.
 */
export interface RefusedFact {
  text: string;
}

export interface ReviewRequest {
  events: readonly ReviewEvent[];
  /** The memory as it stands, so nothing already known is proposed again. */
  memory: string;
  /**
   * Facts the user has already said no to, so they are not asked about twice.
   *
   * Not folded into `memory`: the memory file is what the agent *knows*, and this
   * is what it was told not to suggest. Keeping them apart matters because the
   * agent may still know a refused fact — the user can refuse a *suggestion* and
   * still say the thing themselves later — and a prompt that confused the two
   * would have the reviewer arguing with the memory file.
   */
  refused?: readonly RefusedFact[];
  /**
   * Answers the user marked as wrong, newest last.
   *
   * A different judgement from a refusal, and it reaches the reviewer for a
   * different reason. A refusal says "do not remember that"; a correction says
   * "that answer was wrong, and here is what is right" — which is the strongest
   * evidence this prompt ever gets that something belongs in memory, because the
   * user has already done the work of stating it.
   */
  corrections?: readonly Correction[];
  /** Asks the model. Injected, so the whole review is testable without one. */
  ask: (prompt: string) => Promise<string>;
}

/**
 * One answer the user said was wrong.
 *
 * Carries what was said as well as what was right, because the correction alone
 * is often a fragment — "no, it is pnpm" — and a reviewer that cannot see what it
 * is a correction *of* has to guess at the sentence it completes.
 */
export interface Correction {
  /** What the agent said, capped by the caller. */
  excerpt: string;
  /** What the user typed, when they typed anything. */
  text: string;
}

/**
 * What one review produced, and how far into the conversation it read.
 *
 * `used` travels with the proposals because the caller owns the watermark: only
 * it knows where this stretch started, and only the pair of numbers together say
 * where the next look should resume.
 */
export interface ReviewResult {
  proposals: MemoryProposal[];
  /** How many of the events handed in this look covered. */
  used: number;
}

/**
 * Reads a conversation and returns the facts worth remembering.
 *
 * The orchestration is here rather than in the host so the whole thing — the
 * transcript rendering, the prompt, the parse, the filter against memory — can be
 * tested with a function instead of a provider. What comes back has been checked
 * against the transcript and against memory; the caller writes it, and the
 * person's control is the editable memory list rather than a second approval.
 *
 * A failure from the model answers no proposals. A review is something that
 * happens on its own while nobody is watching, so an exception would surface as
 * an unhandled rejection at an idle moment; and there is nothing to tell the
 * user, because nothing happened. The stretch still counts as read, because it
 * was handed to the model — advancing only on success would re-send a failing
 * prompt on every idle moment.
 */
export async function runReview(request: ReviewRequest): Promise<ReviewResult> {
  const stretch = renderConversation(request.events);
  if (stretch.text.trim().length === 0) {
    return {proposals: [], used: stretch.used};
  }

  let answer: string;
  try {
    answer = await request.ask(
      reviewPrompt(
        stretch.text,
        request.refused ?? [],
        request.memory,
        request.corrections ?? [],
      ),
    );
  } catch {
    return {proposals: [], used: stretch.used};
  }

  /*
   * A correction is stated in the feedback note, not in the conversation, and
   * it is the strongest evidence the reviewer gets. Including it here means a
   * proposal that quotes the user's correction survives the check rather than
   * being discarded for quoting words the transcript never contained.
   */
  const evidenceText = [
    stretch.text,
    ...(request.corrections ?? []).flatMap((entry) => [
      entry.text,
      entry.excerpt,
    ]),
  ].join('\n');

  const proposals: MemoryProposal[] = [];
  for (const proposal of parseProposals(answer)) {
    const quote = proposal.evidence?.quote;
    /*
     * No quote, no proposal. This is the deterministic half of "do not infer":
     * a model can write a confident sentence about a project it never read, and
     * the only cost of dropping that is one suggestion the user does not see.
     */
    if (quote === undefined || !quoteAppears(quote, evidenceText)) {
      continue;
    }
    if (!isNewProposal(proposal, request.memory)) {
      continue;
    }
    if (wasRefused(proposal, request.refused ?? [])) {
      continue;
    }
    const turnId = turnOfQuote(quote, request.events);
    proposals.push({
      ...proposal,
      evidence: {
        quote,
        ...(turnId === undefined ? {} : {turnId}),
      },
    });
  }
  return {proposals, used: stretch.used};
}

/**
 * Whether the user has already said no to this suggestion.
 *
 * Compared the same way the store dedupes refusals and the same way
 * `isNewProposal` compares against memory — collapsed and case-insensitive —
 * because the model will re-word a fact slightly and a filter that only caught
 * exact repeats would let it ask again in a way nobody could see. Deliberately
 * *not* a prefix or substring match: a refusal is of a specific sentence, and
 * treating a shared opening as the same fact would silence a whole subject
 * because one sentence about it was refused.
 *
 * The prompt asks for this too. Both are here because the two fail differently:
 * a model that ignores an instruction wastes a call, and a model that ignores
 * this filter puts a rejected fact back in front of the user.
 */
export function wasRefused(
  proposal: MemoryProposal,
  refused: readonly RefusedFact[],
): boolean {
  const normalise = (value: string): string =>
    value.toLowerCase().replaceAll(/\s+/gu, ' ').trim();
  const target = normalise(proposal.text);
  if (target.length === 0) {
    return false;
  }
  return refused.some((entry) => normalise(entry.text) === target);
}

/**
 * One look's worth of a conversation: the text, and how far it reached.
 *
 * `used` is the point of the pair. A review reads a fixed number of characters,
 * and a conversation longer than that has to be read over several looks — so the
 * caller needs to know which events this look actually covered, because the
 * watermark may only move past those. Rendering the tail and then advancing past
 * the whole slice is how the beginning of a long conversation is marked read
 * without ever having been sent anywhere.
 */
export interface ReviewStretch {
  /** The conversation text for one look, at most {@link MAX_REVIEW_CHARS}. */
  text: string;
  /** How many of the events handed in are covered by `text`. */
  used: number;
}

/**
 * The conversation as text for the reviewer.
 *
 * Reasoning parts are left out: they are the model's working, not what was said,
 * and a review that read them would propose things nobody stated. The agent's
 * tool calls are left out for the same reason — "the agent read a file" is not a
 * fact about the user.
 *
 * Capped at a stretch taken from the *earliest* event it was handed, which is
 * the earliest not yet reviewed. Taking the tail instead would prefer the most
 * recent exchange when a backlog is large, and it cannot be made to cover the
 * conversation: the events it dropped are in front of the watermark, so the next
 * look would either send them again forever or step over them. A look that
 * starts where the last one stopped loses nothing, and the calls that drain a
 * long backlog are spaced by the review cadence rather than run back to back.
 */
export function renderConversation(
  events: readonly ReviewEvent[],
): ReviewStretch {
  const lines: string[] = [];
  let length = 0;
  let used = 0;

  for (const event of events) {
    used += 1;
    const text = (event.content?.parts ?? [])
      .filter((part) => part.thought !== true)
      .map((part) => part.text ?? '')
      .filter((part) => part.length > 0)
      .join('')
      .trim();
    if (text.length === 0) {
      // Nothing to review, and nothing for the next look to carry.
      continue;
    }
    const who = event.author === 'user' ? 'USER' : 'AGENT';
    const line = `${who}: ${text}`;
    const added = lines.length === 0 ? line.length : line.length + 2;
    if (lines.length > 0 && length + added > MAX_REVIEW_CHARS) {
      /*
       * The event belongs to the next look, and `used` must not count it or the
       * watermark would step over text no prompt ever carried. The first line is
       * taken whatever its size, so a single enormous message still makes
       * progress instead of being retried forever.
       */
      used -= 1;
      break;
    }
    lines.push(line);
    length += added;
  }

  return {text: lines.join('\n\n'), used};
}
