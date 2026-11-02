/**
 * The merge used for Chromium's `disable-features`.
 *
 * The failure this prevents is a launcher's switches being replaced by the one
 * feature the app needs, which is invisible: the app still starts, and something
 * else that was deliberately disabled comes back.
 */
import {describe, expect, it} from 'vitest';

import {withDisabledFeature} from '../src/shared/chromium-flags.js';

describe('withDisabledFeature', () => {
  it('adds the feature to an empty list', () => {
    expect(withDisabledFeature('', 'Vulkan')).toBe('Vulkan');
  });

  it('keeps the features a launcher already disabled', () => {
    expect(withDisabledFeature('Foo,Bar', 'Vulkan')).toBe('Foo,Bar,Vulkan');
  });

  it('does not add a feature that is already there', () => {
    expect(withDisabledFeature('Foo,Vulkan', 'Vulkan')).toBe('Foo,Vulkan');
  });

  it('normalises spaces and empty entries', () => {
    expect(withDisabledFeature(' Foo, , Bar ', 'Vulkan')).toBe(
      'Foo,Bar,Vulkan',
    );
  });
});
