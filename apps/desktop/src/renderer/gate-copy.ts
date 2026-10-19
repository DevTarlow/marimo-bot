/**
 * How one approval gate reads on screen.
 *
 * A gate carries ADK's own hint, which is written for a model — "respond with a
 * FunctionResponse with an expected ToolConfirmation payload" — and showing it
 * verbatim is what made the cards jargon. When that hint says nothing to a
 * person, the summary built from the call's arguments is used instead, so the
 * card names the file, the command or the job. A hint that *is* useful wins,
 * because only the tool that raised it knows what a helper is doing.
 *
 * Pure, so the window and the companion bubble read the same card the same way,
 * and the wording is unit-tested without a DOM.
 */
import {meaningfulHint, summarizeApproval} from '@marimo/protocol';
import type {PendingGate} from '@marimo/protocol';

export interface GateCopy {
  /** One line naming the action, e.g. "Overwrite this existing file". */
  heading: string;
  /** A human sentence from the tool itself, when it has one. */
  hint?: string;
  /** The exact argument text, when the summary has it. */
  primary?: string;
  note?: string;
  detail?: string;
  detailLabel?: string;
}

export function gateCopy(gate: PendingGate): GateCopy {
  const preview = summarizeApproval(gate.tool, gate.args);

  if (meaningfulHint(gate.hint)) {
    return {heading: preview.headline, hint: gate.hint.trim()};
  }

  return {
    heading: preview.headline,
    ...(preview.primary.trim().length > 0 ? {primary: preview.primary} : {}),
    ...(preview.note === undefined ? {} : {note: preview.note}),
    ...(preview.detail === undefined ? {} : {detail: preview.detail}),
    ...(preview.detailLabel === undefined
      ? {}
      : {detailLabel: preview.detailLabel}),
  };
}
