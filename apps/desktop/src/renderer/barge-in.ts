/**
 * Whether an event is the microphone taking the floor from the voice.
 *
 * The host has already marked its utterances cancelled; this is the renderer's
 * half, which stops the audio already scheduled on the context so the microphone
 * does not hear the rest of a sentence. It lives outside the hook so the rule can
 * be tested without a DOM.
 */
import type {AgentUiEvent} from '@marimo/protocol';

export function isBargeIn(event: AgentUiEvent): boolean {
  return event.type === 'listen.capture' && event.active;
}
