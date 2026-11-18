/**
 * What the pet asks for.
 *
 * The sentences are the feature: a length setting that produced the same words
 * for all three values would be a switch that does nothing, and one that
 * produced *no* words would be a setting the agent never hears about. Both are
 * silent, so both are asserted here.
 */
import {describe, expect, it} from 'vitest';

import {COMPANION_ANSWER_LENGTHS} from '@marimo/protocol';

import {turnInstruction} from './pet-turn.js';

describe('turnInstruction', () => {
  it('says nothing for a turn asked in the window', () => {
    for (const length of COMPANION_ANSWER_LENGTHS) {
      expect(turnInstruction('window', length)).toBeUndefined();
    }
  });

  it('says nothing when no surface claimed the turn', () => {
    // Every caller that predates the companion: a job, a Discord mention, a
    // test. They must keep getting exactly the instruction they got before.
    expect(turnInstruction(undefined, 'brief')).toBeUndefined();
  });

  it('gives every length its own instruction', () => {
    const written = COMPANION_ANSWER_LENGTHS.map((length) =>
      turnInstruction('pet', length),
    );

    for (const instruction of written) {
      expect(instruction).toBeTypeOf('string');
    }
    expect(new Set(written).size).toBe(COMPANION_ANSWER_LENGTHS.length);
  });

  it('tells the brief answer what to leave out', () => {
    const brief = turnInstruction('pet', 'brief') ?? '';

    /*
     * The failure this is really about: a model told only "be brief" answers
     * briefly and then appends the caveats. The instruction has to name what to
     * drop, not just how long to be.
     */
    expect(brief).toMatch(/no preamble/iu);
    expect(brief).toMatch(/caveats/u);
    // And that brevity is not allowed to cost correctness.
    expect(brief).toMatch(/never costs accuracy/u);
  });

  it('gives a window turn a spoken instruction when the answer will be read', () => {
    const spoken = turnInstruction('window', 'brief', undefined, 'brief') ?? '';
    expect(spoken).toMatch(/read aloud/iu);
    expect(spoken).toMatch(/main window/iu);
    expect(spoken).toMatch(/no preamble/iu);
  });

  it('lets the spoken length win over the companion’s text length', () => {
    const spoken = turnInstruction('pet', 'detailed', undefined, 'brief') ?? '';
    expect(spoken).toMatch(/desktop companion/iu);
    expect(spoken).toMatch(/read aloud/iu);
    // The companion's detailed block would say this; the spoken brief must not.
    expect(spoken).not.toMatch(/Answer completely/u);
  });

  it('writes a different spoken instruction for each length', () => {
    const written = COMPANION_ANSWER_LENGTHS.map((length) =>
      turnInstruction('window', length, undefined, length),
    );
    expect(new Set(written).size).toBe(COMPANION_ANSWER_LENGTHS.length);
  });

  it('keeps the context after the spoken block', () => {
    const instruction =
      turnInstruction('window', 'brief', 'It is Tuesday.', 'brief') ?? '';
    expect(instruction.indexOf('read aloud')).toBeLessThan(
      instruction.indexOf('It is Tuesday.'),
    );
  });

  it('tells the detailed answer that the pet is not the wrong place to be thorough', () => {
    const detailed = turnInstruction('pet', 'detailed') ?? '';

    // Otherwise the identity's own "prefer a short, direct answer" wins and the
    // setting does nothing.
    expect(detailed).toMatch(/Answer completely/u);
  });
});
