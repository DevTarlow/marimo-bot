import {describe, expect, it} from 'vitest';

import {appendTranscript, TranscriptGate} from '../src/renderer/voice-insert.js';

describe('appendTranscript', () => {
  it('keeps the words already in the box', () => {
    expect(appendTranscript('Half a thought', 'and the rest.')).toBe(
      'Half a thought and the rest.',
    );
  });

  it('trims the transcript and the join', () => {
    expect(appendTranscript('', '  hello  ')).toBe('hello');
    expect(appendTranscript('already ', ' there ')).toBe('already there');
  });

  it('does nothing for an empty transcript', () => {
    expect(appendTranscript('kept', '   ')).toBe('kept');
    expect(appendTranscript('', '')).toBe('');
  });
});

describe('TranscriptGate', () => {
  it('accepts only the newest recording', () => {
    const gate = new TranscriptGate();
    const first = gate.begin();
    expect(gate.accepts(first)).toBe(true);
    const second = gate.begin();
    expect(gate.accepts(first)).toBe(false);
    expect(gate.accepts(second)).toBe(true);
  });

  it('rejects a recording that was cancelled', () => {
    const gate = new TranscriptGate();
    const id = gate.begin();
    gate.cancel();
    expect(gate.accepts(id)).toBe(false);
  });
});
