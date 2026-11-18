import {describe, expect, it} from 'vitest';

import {expandSpeakable, expandToken, spellLetters} from './expand.js';

describe('expandSpeakable', () => {
  it('splits a kebab case file name and spells the extension', () => {
    expect(expandSpeakable('speech-host.ts')).toBe('speech host tee ess');
  });

  it('splits a path and maps src to a word', () => {
    expect(expandSpeakable('src/renderer/speech.ts')).toBe(
      'source renderer speech tee ess',
    );
  });

  it('splits camelCase and spells an acronym inside it', () => {
    expect(expandSpeakable('getURLValue')).toBe('get you ar ell Value');
  });

  it('spells short all-caps abbreviations', () => {
    expect(expandSpeakable('API ORT TTS CPU CLI ONNX JSON')).toBe(
      'ay pee eye oh ar tee tee tee ess see pee you see ell eye oh en en ex ' +
        'jay ess oh en',
    );
  });

  it('keeps all-caps words that are words', () => {
    expect(expandSpeakable('README and NOTICE')).toBe('read me and notice');
  });

  it('leaves a long shouted word alone so the lexicon can say it', () => {
    expect(expandSpeakable('HELLO')).toBe('hello');
  });

  it('splits snake_case and hyphenated words', () => {
    expect(expandSpeakable('file_name and well-known')).toBe(
      'file name and well known',
    );
  });

  it('reads a version prefix as the word version', () => {
    expect(expandSpeakable('v0.1.0')).toBe('version 0.1.0');
  });

  it('leaves decimals and ordinary words alone', () => {
    expect(expandSpeakable('3.5 and Kubernetes')).toBe('3.5 and Kubernetes');
  });

  it('keeps a contraction whole', () => {
    expect(expandSpeakable("don't")).toBe("don't");
  });

  it('expands dotted abbreviations before they can be split', () => {
    expect(expandSpeakable('e.g. i.e. p.m. U.S.')).toBe(
      'for example. that is. pee em. you ess.',
    );
  });

  it('spells letters through one helper', () => {
    expect(spellLetters('API')).toBe('ay pee eye');
    expect(expandToken('TTS')).toBe('tee tee ess');
  });
});
