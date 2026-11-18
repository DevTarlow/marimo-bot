import {describe, expect, it} from 'vitest';

import {isOwnedListenDir, listenDir, listenRoot} from './files.js';

describe('voice-input paths', () => {
  it('live under the model root the rest of the app resolves', () => {
    const options = {userData: '/home/me/.config/Marimo Bot'};
    expect(listenRoot(options)).toBe(
      '/home/me/.config/Marimo Bot/model/listen',
    );
    expect(listenDir(options)).toBe(
      '/home/me/.config/Marimo Bot/model/listen/small',
    );
  });

  it('honour the model-directory override', () => {
    expect(
      listenDir({userData: '/ignored', env: {MARIMO_MODEL_DIR: '/models'}}),
    ).toBe('/models/listen/small');
  });

  it('recognise only a directory this app owns', () => {
    expect(isOwnedListenDir('/models/listen/small')).toBe(true);
    expect(isOwnedListenDir('/models/listen/tiny')).toBe(false);
    expect(isOwnedListenDir('/models/tts/small')).toBe(false);
    expect(isOwnedListenDir('/models/listen')).toBe(false);
    expect(isOwnedListenDir('/models/listen/small/extra')).toBe(false);
  });
});
