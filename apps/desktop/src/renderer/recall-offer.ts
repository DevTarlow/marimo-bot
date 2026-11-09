/**
 * When the recall card is worth raising, as arithmetic rather than as an effect.
 *
 * It lives here because the bug it fixes was invisible from the outside and easy
 * to write again. `settings` is `null` until the first read lands, and a
 * `modelReady` derived from it reads `false` in the meantime — the same `false` a
 * launch with the model server off reports. An effect that watched `modelReady`
 * alone therefore saw a real transition into ready on every launch, and asked the
 * once-ever question every time the app was opened.
 *
 * So a read answers two things, and the second is the one that was missing: raise
 * the card or not, and what to remember for the next read. What may be remembered
 * is only ever what a payload said. Before one arrives there is no opinion to
 * record, and recording the default instead is precisely how "the model just
 * became ready" came to be true on every launch.
 */
export interface RecallOfferRead {
  /** Whether a settings payload has been read at all. */
  loaded: boolean;
  /** What the last read recorded, or `null` before the first payload. */
  wasReady: boolean | null;
  modelReady: boolean;
  /** Whether the user already has recall switched on. */
  enabled: boolean;
  /** Whether the card has been answered before. */
  introSeen: boolean;
}

export interface RecallOfferAnswer {
  /** Whether the card should go up now. */
  offer: boolean;
  /** What the next read should compare against. */
  remember: boolean | null;
}

/**
 * The offer stands when five things hold, and each rules out a different way of
 * asking twice or asking at the wrong moment: a payload has arrived, the last one
 * said the server was not answering, this one says it is, the user has not already
 * switched the feature on, and they have not already answered the card. The last
 * two are what make "once" mean once rather than "once per restart": somebody who
 * pressed "Not now" and later started their server is not a new question.
 */
export function recallOfferOnRead(seen: RecallOfferRead): RecallOfferAnswer {
  return {
    offer:
      seen.loaded &&
      seen.wasReady === false &&
      seen.modelReady &&
      !seen.enabled &&
      !seen.introSeen,
    remember: seen.loaded ? seen.modelReady : seen.wasReady,
  };
}
