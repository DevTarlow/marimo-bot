/**
 * What the window says when the model server answers but cannot call tools.
 *
 * The app does not own the server any more, so the chat template is the
 * person's setup: a model whose template has no tools block still holds a
 * conversation, and every file, job and connector tool is silently absent.
 * The old build passed its own tools-capable template to the engine it started,
 * which is why this used to be invisible; the probe can see the mismatch now,
 * and the three places a person looks — the first run, the Settings card and
 * the composer — say the same thing rather than leaving a green dot over a bot
 * that cannot do anything.
 *
 * The wording is shared rather than written three times because a card and a
 * badge that disagree about what is broken is worse than either alone.
 */
import type {ModelServerStatus} from '@marimo/protocol';

/**
 * True only when the server answered and its template has no tools block.
 *
 * A server that is off or failed has no opinion here: the badge is already
 * resting or failed, and a second sentence about tools would be noise on top of
 * the one that names the address.
 */
export function cannotCallTools(
  status: ModelServerStatus | undefined,
): boolean {
  return status?.state === 'ready' && status.tools === false;
}

/** The Settings card: what is broken, what stops working, and the fix. */
export const TOOLS_OFF_CARD =
  'This server’s chat template has no tools block, so the bot can answer but ' +
  'cannot read your files, run jobs or use connectors — and it may describe ' +
  'work it did not do. Use a model whose template includes tool calls.';

/** The first run, beside the button that decides whether to continue. */
export const TOOLS_OFF_SETUP =
  'This server can answer, but its template cannot call tools, so the bot ' +
  'will not be able to read your files or run jobs. Use a model whose ' +
  'template includes tool calls.';

/** The composer badge, in the tooltip the badge already has. */
export const TOOLS_OFF_BADGE =
  'this server cannot call tools, so the bot can chat but cannot use your files or jobs';

/**
 * The first run's button.
 *
 * "Continue" is honest only when the thing it continues into can do the work;
 * when the server cannot call tools, the label is where the trade-off is made
 * rather than in a warning the person has already scrolled past.
 */
export function continueLabel(cannotCallTools: boolean): string {
  return cannotCallTools ? 'Continue without tools' : 'Continue';
}
