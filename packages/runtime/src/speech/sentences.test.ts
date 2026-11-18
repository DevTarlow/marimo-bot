import {describe, expect, it} from 'vitest';

import {splitSpeechSentences} from './sentences.js';

describe('splitSpeechSentences', () => {
  it('keeps an abbreviation, a decimal and a version together', () => {
    expect(
      splitSpeechSentences('Dr. Smith paid $3.50 for v1.2.3. It works! Next?'),
    ).toEqual(['Dr. Smith paid $3.50 for v1.2.3.', 'It works!', 'Next?']);
  });

  it('keeps e.g. and i.e. inside the sentence', () => {
    expect(splitSpeechSentences('e.g. this, i.e. that. Done.')).toEqual([
      'e.g. this, i.e. that.',
      'Done.',
    ]);
  });

  it('keeps an ellipsis as one boundary and a version whole', () => {
    expect(splitSpeechSentences('Wait... then v2.0.1 ships.')).toEqual([
      'Wait...',
      'then v2.0.1 ships.',
    ]);
    expect(
      splitSpeechSentences('v2.0.1 ships.').some((sentence) =>
        sentence.startsWith('.'),
      ),
    ).toBe(false);
  });

  it('treats a newline as a boundary', () => {
    expect(splitSpeechSentences('One line.\nTwo line.')).toEqual([
      'One line.',
      'Two line.',
    ]);
  });

  it('splits one over-long sentence before the limit', () => {
    const text = `${'word '.repeat(80).trim()}.`;
    const sentences = splitSpeechSentences(text, 100);
    expect(sentences.length).toBeGreaterThan(1);
    for (const sentence of sentences) {
      expect(sentence.length).toBeLessThanOrEqual(100);
    }
  });

  it('returns nothing for an empty answer', () => {
    expect(splitSpeechSentences('   ')).toEqual([]);
  });
});
