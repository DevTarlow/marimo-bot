/**
 * The personal details a person says out loud, written down before the answer.
 *
 * The model has `update_memory`, and a 2B model is unreliable about reaching for
 * it. In the session that prompted this, "my name is tarlow rember that" was
 * answered with "My name is Marimo Bot, not Tarlow": the model had the memory
 * file in front of it and no instruction that the sentence was a fact about the
 * person, so it read the sentence as a correction of its own identity. Waiting
 * for the idle review would put the fact in memory a minute later, after the
 * answer that needed it — and the review is the same small model.
 *
 * So this is the deterministic half. A first-person statement with a shape that
 * is unambiguous is turned into a third-person bullet and written into the
 * person's memory **before the turn starts**, which means the model answering
 * "my name is Tarlow" already has `The user's name is Tarlow.` in its prompt.
 * The review remains the path for everything that has to be inferred.
 *
 * Conservative by construction: only explicit first-person shapes, one fact per
 * key, at most five a message, and no guessing. A missed detail is a review
 * entry; a wrong one is a belief the agent carries into every conversation.
 */
import {splitMemory} from './memory-store.js';
import type {MemoryStore} from './memory-store.js';

/** The one layer a personal detail belongs in, whatever its shape. */
const SECTION = 'About the user';

/** The most facts one message may add. A message that is a list is a list. */
const MAX_FACTS = 5;

/** Longest value each shape may carry before it is treated as not a fact. */
const LIMITS = {
  name: 60,
  age: 3,
  birthday: 60,
  location: 60,
  work: 60,
  relation: 60,
  favourite: 120,
} as const;

/** One fact, and the older bullet it would replace. */
export interface PersonalFact {
  /** Stable identity for one fact: two names are one fact, two dogs are two. */
  key: string;
  section: typeof SECTION;
  /** The bullet as it is written, in the third person. */
  text: string;
  /** Matches an older bullet for the same key, so a correction can replace it. */
  existing: RegExp;
}

/** What one message added, and how much of it replaced something. */
export interface PersonalCapture {
  written: number;
  corrected: number;
}

/**
 * First words that are never a name: a sentence that says "my name is a
 * secret", "my name is not important" or "my name is the same" is not telling
 * the agent a name.
 */
const NOT_A_NAME: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'my',
  'your',
  'his',
  'her',
  'their',
  'our',
  'not',
  'no',
  'still',
  'just',
  'actually',
  'really',
  'also',
  'only',
  'called',
  'named',
]);

/** Words that make a place phrase a relative one rather than a location. */
const NOT_A_PLACE: ReadonlySet<string> = new Set([
  'here',
  'there',
  'this',
  'that',
]);

/*
 * Where one statement ends and the next begins.
 *
 * A sentence break is only taken when the next word is one this file could be
 * about — a first-person pronoun, or the common way a message starts a new
 * thought. "I live in St. Louis" is one place, not two clauses; "my name is
 * Tarlow. I live in Berlin" is two facts. Splitting on every period would make
 * St. Louis a location called "St".
 */
const CLAUSE_SPLIT =
  /\n+|[!?;]+|\s+and\s+(?=(?:i|we|my|our)\b)|(?<=[.!])\s+(?=(?:i|we|my|our|the|this|that|there|what|how|do|does|can|could|would|will|please|thanks|remember)\b)/iu;

const NAME = /\b(?:my|our)\s+name(?:['’]s|\s+is)\s+([^,.;!?\n]{1,60})/iu;
const CALL_ME = /\bcall me\s+([^,.;!?\n]{1,60})/iu;
const AGE = /\bi(?:['’]m|\s+am)\s+(\d{1,3})\s*(?:years?\s*old|yo)\b/iu;
const BIRTHDAY = /\b(?:my|our)\s+birthday\s+is\s+([^\n;!?]{3,60})/iu;
const LOCATION = /\b(?:i|we)\s+live\s+in\s+([^\n;!?]{2,60})/iu;
const ORIGIN = /\bi(?:['’]m|\s+am)\s+from\s+([^\n;!?]{2,60})/iu;
const WORK = /\b(?:i|we)\s+work\s+(?:at|for)\s+([^\n;!?]{2,60})/iu;
const RELATION =
  /\b(?:my|our)\s+(partner|wife|husband|girlfriend|boyfriend|fianc[ée]e?|son|daughter|child|kid|dog|cat|pet|mother|mom|mum|father|dad|brother|sister|friend)(?:['’]s\s+name\s+is|\s+is\s+called|\s+is\s+named|['’]s\s+called)\s+([^,.;!?\n]{1,60})/iu;
const FAVOURITE =
  /\b(?:my|our)\s+(?:favourite|favorite)\s+([^.;!?\n]{1,40}?)\s+(is|are)\s+([^\n;!?]{1,120})/iu;

/**
 * The personal facts in one message, in the order they were said.
 *
 * A clause at a time, because a single sentence can hold two facts ("my name is
 * Tarlow and I live in Berlin") and a value must not run across the "and". The
 * split is narrow deliberately: "Salt and Pepper" is one place.
 */
export function personalFactsIn(text: string): PersonalFact[] {
  const facts: PersonalFact[] = [];
  const seen = new Set<string>();

  const add = (fact: PersonalFact | undefined): void => {
    if (fact === undefined || seen.has(fact.key) || facts.length >= MAX_FACTS) {
      return;
    }
    seen.add(fact.key);
    facts.push(fact);
  };

  for (const raw of text.split(CLAUSE_SPLIT)) {
    const clause = cleanClause(raw);
    if (clause.length === 0) {
      continue;
    }

    const name = cleanValue(NAME.exec(clause)?.[1]);
    if (name !== undefined && isName(name)) {
      add({
        key: 'name',
        section: SECTION,
        text: `The user's name is ${name}.`,
        existing: /^The user(?:['’]s)? name is /iu,
      });
    }

    const nickname = cleanValue(CALL_ME.exec(clause)?.[1]);
    if (nickname !== undefined && isName(nickname)) {
      add({
        key: 'nickname',
        section: SECTION,
        text: `The user prefers to be called ${nickname}.`,
        existing: /^The user prefers to be called /iu,
      });
    }

    const age = cleanValue(AGE.exec(clause)?.[1]);
    if (age !== undefined && /^\d{1,3}$/u.test(age)) {
      const years = Number(age);
      if (years >= 1 && years <= 120) {
        add({
          key: 'age',
          section: SECTION,
          text: `The user is ${String(years)} years old.`,
          existing: /^The user is \d{1,3} years old/iu,
        });
      }
    }

    const birthday = cleanValue(BIRTHDAY.exec(clause)?.[1]);
    if (birthday !== undefined && isValue(birthday, LIMITS.birthday)) {
      add({
        key: 'birthday',
        section: SECTION,
        text: `The user's birthday is ${birthday}.`,
        existing: /^The user(?:['’]s)? birthday is /iu,
      });
    }

    const location = cleanValue(LOCATION.exec(clause)?.[1]);
    if (
      location !== undefined &&
      isValue(location, LIMITS.location) &&
      !firstWordIn(location, NOT_A_PLACE)
    ) {
      add({
        key: 'location',
        section: SECTION,
        text: `The user lives in ${location}.`,
        existing: /^The user lives in /iu,
      });
    }

    const origin = cleanValue(ORIGIN.exec(clause)?.[1]);
    if (
      origin !== undefined &&
      isValue(origin, LIMITS.location) &&
      !firstWordIn(origin, NOT_A_PLACE)
    ) {
      add({
        key: 'origin',
        section: SECTION,
        text: `The user is from ${origin}.`,
        existing: /^The user is from /iu,
      });
    }

    const work = cleanValue(WORK.exec(clause)?.[1]);
    if (work !== undefined && isValue(work, LIMITS.work)) {
      add({
        key: 'work',
        section: SECTION,
        text: `The user works at ${work}.`,
        existing: /^The user works at /iu,
      });
    }

    const relation = RELATION.exec(clause);
    const relationName = cleanValue(relation?.[2]);
    const relationKind = relation?.[1]?.toLocaleLowerCase();
    if (
      relationKind !== undefined &&
      relationName !== undefined &&
      isValue(relationName, LIMITS.relation)
    ) {
      add({
        key: `relation:${relationKind}`,
        section: SECTION,
        text: `The user's ${relationKind} is called ${relationName}.`,
        existing: new RegExp(
          `^The user(?:['’]s)? ${escapeRegExp(relationKind)} is called `,
          'iu',
        ),
      });
    }

    const favourite = FAVOURITE.exec(clause);
    const favouriteThing = cleanValue(favourite?.[1])?.toLocaleLowerCase();
    const favouriteValue = cleanValue(favourite?.[3]);
    if (
      favourite !== null &&
      favouriteThing !== undefined &&
      favouriteThing.length > 0 &&
      favouriteThing.length <= 40 &&
      favouriteValue !== undefined &&
      isValue(favouriteValue, LIMITS.favourite)
    ) {
      add({
        key: `favourite:${favouriteThing}`,
        section: SECTION,
        text: `The user's favourite ${favouriteThing} ${favourite[2] ?? 'is'} ${favouriteValue}.`,
        existing: new RegExp(
          `^The user(?:['’]s)? favou?rite ${escapeRegExp(favouriteThing)} `,
          'iu',
        ),
      });
    }
  }

  return facts;
}

/**
 * Writes what this message said about the person, before the turn answers it.
 *
 * An identical bullet is already remembered, so a repeat costs nothing. A
 * changed value for the same key is a correction: every older bullet for that
 * key is forgotten first and the new one written after, so memory never holds
 * both "Tarlow" and "Bob" and the model is never asked to pick.
 *
 * Throws on a store failure; the caller is the turn, and it must treat a cap or
 * an unreadable file as no capture rather than as a failed turn.
 */
export async function rememberPersonalDetails(
  store: MemoryStore,
  text: string,
): Promise<PersonalCapture> {
  const facts = personalFactsIn(text);
  if (facts.length === 0) {
    return {written: 0, corrected: 0};
  }

  let bullets = bulletsInSection(await store.read(), SECTION);
  let written = 0;
  let corrected = 0;

  for (const fact of facts) {
    if (
      bullets.some((bullet) => comparable(bullet) === comparable(fact.text))
    ) {
      continue;
    }
    const older = bullets.filter((bullet) => fact.existing.test(bullet));
    for (const bullet of older) {
      await store.forget({scope: 'person', section: SECTION, text: bullet});
    }
    await store.update({content: fact.text, section: SECTION});
    if (older.length > 0) {
      corrected += 1;
    } else {
      written += 1;
    }
    bullets = [
      ...bullets.filter((bullet) => !older.includes(bullet)),
      fact.text,
    ];
  }

  return {written, corrected};
}

/** The bullets under one heading in the merged memory document. */
function bulletsInSection(text: string, section: string): string[] {
  const wanted = section.toLocaleLowerCase();
  const bullets: string[] = [];
  for (const block of splitMemory(text)) {
    if ((block.heading ?? '').trim().toLocaleLowerCase() !== wanted) {
      continue;
    }
    for (const line of block.lines) {
      const match = /^\s*[-*]\s+(.+?)\s*$/u.exec(line);
      if (match?.[1] !== undefined && match[1].length > 0) {
        bullets.push(match[1]);
      }
    }
  }
  return bullets;
}

/**
 * Removes the request part from the sentence it was attached to.
 *
 * "my name is tarlow rember that" and "my name is tarlow, remember that" are one
 * statement about a name and one request about it. The request is not a value,
 * and a name that includes it would be a belief the agent repeats.
 */
function cleanClause(clause: string): string {
  return clause
    .replace(
      /\s*[,;:]?\s*(?:please\s+)?(?:remember|rember|don['’]?t forget)(?:\s+that)?\s*$/iu,
      '',
    )
    .trim();
}

/** A value with the quotes and decoration a sentence puts around it removed. */
function cleanValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const clean = value
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, '')
    .replace(/[.,;:!?]+$/u, '')
    .trim();
  return clean.length > 0 ? clean : undefined;
}

/** Whether a value looks like a name rather than the rest of a sentence. */
function isName(value: string): boolean {
  if (value.length > LIMITS.name) {
    return false;
  }
  if (!/\p{L}/u.test(value)) {
    return false;
  }
  const words = value.split(/\s+/u);
  if (words.length > 4) {
    return false;
  }
  const first = words[0]?.toLocaleLowerCase() ?? '';
  return first.length > 0 && !NOT_A_NAME.has(first);
}

/** Whether a value is worth writing at all. */
function isValue(value: string, limit: number): boolean {
  return (
    value.length > 0 &&
    value.length <= limit &&
    /\p{L}|\d/u.test(value) &&
    !/[?!]/u.test(value)
  );
}

function firstWordIn(value: string, words: ReadonlySet<string>): boolean {
  const first = value.toLocaleLowerCase().split(/\s+/u)[0] ?? '';
  return words.has(first);
}

function comparable(value: string): string {
  return value.toLocaleLowerCase().replaceAll(/\s+/gu, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
