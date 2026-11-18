/**
 * The 16 fixtures from the model repository's `tts_norm.py`, which are the
 * failures the normaliser exists for. Expected strings are this port's output:
 * the words are the same, and a different word order here would be a different
 * normaliser, not a better one.
 */
import {describe, expect, it} from 'vitest';

import {cardinal, normalizeEnglish, ordinal, year} from './normalize.js';

describe('normalizeEnglish', () => {
  it('reads money in dollars and cents', () => {
    expect(normalizeEnglish('It cost $5.99 at the store.')).toBe(
      'It cost five dollars and ninety-nine cents at the store.',
    );
  });

  it('reads St. by its context', () => {
    expect(normalizeEnglish('Dr. Smith lives on St. Paul St.')).toBe(
      'Doctor Smith lives on Saint Paul Street.',
    );
  });

  it('reads a time and an ISO date', () => {
    expect(normalizeEnglish('The meeting is at 3:45pm on 2026-10-13.')).toBe(
      'The meeting is at three forty-five PM on October thirteenth, twenty ' +
        'twenty-six.',
    );
  });

  it('reads a percentage and a magnitude', () => {
    expect(normalizeEnglish("NASA's budget rose 12% to $24.5B.")).toBe(
      "NASA's budget rose twelve percent to twenty-four point five billion " +
        'dollars.',
    );
  });

  it('reads a Roman numeral in context', () => {
    expect(normalizeEnglish('Chapter IV, section 3b.')).toBe(
      'Chapter four, section 3b.',
    );
  });

  it('reads a phone number and an extension', () => {
    expect(normalizeEnglish('Call 555-0123 ext. 42.')).toBe(
      'Call five five five, zero one two, three extension forty-two.',
    );
  });

  it('reads units and a temperature', () => {
    expect(normalizeEnglish('He ran 5km in 22min.')).toBe(
      'He ran five kilometres in twenty-two minutes.',
    );
    expect(normalizeEnglish('The temperature is -3°C today.')).toBe(
      'The temperature is minus three degrees Celsius today.',
    );
  });

  it('expands the abbreviations a lexicon would read as words', () => {
    expect(normalizeEnglish('e.g. apples, i.e. fruit, etc.')).toBe(
      'for example, apples, that is, fruit, etcetera',
    );
  });

  it('keeps thousands whole and reads symbols', () => {
    expect(normalizeEnglish('She owns 1,234 books & 7 cats.')).toBe(
      'She owns one thousand two hundred and thirty-four books and seven cats.',
    );
  });

  it('reads a bare hour and a zero-padded time', () => {
    expect(normalizeEnglish('Flight AA1234 departs from JFK at 07:05.')).toBe(
      'Flight AA1234 departs from JFK at seven oh five.',
    );
  });

  it('reads a version and a fraction', () => {
    expect(normalizeEnglish('Version 2.0.1 fixes 3/4 of the bugs.')).toBe(
      'Version two point zero point one fixes three quarters of the bugs.',
    );
  });

  it('reads a year, a magnitude and a calendar year', () => {
    expect(normalizeEnglish('Revenue grew 150% to $1.2B in Q3 2025.')).toBe(
      'Revenue grew one hundred and fifty percent to one point two billion ' +
        'dollars in Q3 twenty twenty-five.',
    );
  });

  it('reads units and a temperature in one sentence', () => {
    expect(normalizeEnglish('Mix 250ml water with 1.5kg flour at 180°C.')).toBe(
      'Mix two hundred and fifty millilitres water with one point five ' +
        'kilograms flour at one hundred and eighty degrees Celsius.',
    );
  });

  it('does not read a URL or an email address as words', () => {
    expect(
      normalizeEnglish('Visit https://example.com or email a@b.com.'),
    ).toBe('Visit link or email email address.');
  });

  it('reads a range and a year after a day', () => {
    expect(normalizeEnglish('The 3rd of May, 1999 — see pages 10-15.')).toBe(
      'The third of May, nineteen ninety-nine - see pages ten to fifteen.',
    );
  });

  it('leaves a sentence with no numbers alone', () => {
    expect(normalizeEnglish('The answer is on screen.')).toBe(
      'The answer is on screen.',
    );
  });
});

describe('the number helpers', () => {
  it('reads cardinals', () => {
    expect(cardinal(0)).toBe('zero');
    expect(cardinal(21)).toBe('twenty-one');
    expect(cardinal(123)).toBe('one hundred and twenty-three');
    expect(cardinal(1_234)).toBe('one thousand two hundred and thirty-four');
  });

  it('reads ordinals', () => {
    expect(ordinal(1)).toBe('first');
    expect(ordinal(21)).toBe('twenty-first');
    expect(ordinal(123)).toBe('one hundred and twenty-third');
  });

  it('reads years as years', () => {
    expect(year(1999)).toBe('nineteen ninety-nine');
    expect(year(1905)).toBe('nineteen oh five');
    expect(year(2000)).toBe('two thousand');
    expect(year(2005)).toBe('two thousand five');
    expect(year(2026)).toBe('twenty twenty-six');
  });
});
