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

  it('tells the detailed answer that the pet is not the wrong place to be thorough', () => {
    const detailed = turnInstruction('pet', 'detailed') ?? '';

    // Otherwise the identity's own "prefer a short, direct answer" wins and the
    // setting does nothing.
    expect(detailed).toMatch(/Answer completely/u);
  });

  /*
   * The failure this guards is on disk: a 2B model in the companion answered
   * "I don't have a tool to edit files" after a spoken turn whose last line said
   * only "do not narrate tool use". A small model reads that as "do not use
   * tools", so the instruction has to permit the call in the same breath as it
   * forbids the narration.
   */
  it('lets a spoken answer call tools, and only forbids narrating them', () => {
    const spoken = turnInstruction('pet', 'brief', undefined, true) ?? '';

    expect(spoken).toMatch(/may call tools/u);
    expect(spoken).toMatch(/do not narrate/u);
    expect(spoken).not.toMatch(/Do not narrate tool use/u);
  });

  it('gives the window’s spoken answer the same permission', () => {
    const spoken = turnInstruction('window', 'brief', undefined, true) ?? '';

    expect(spoken).toMatch(/may call tools/u);
  });
});
