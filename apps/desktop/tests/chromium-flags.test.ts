/**
 * The merge used for Chromium's `disable-features`.
 *
 * The failure this prevents is a launcher's switches being replaced by the one
 * feature the app needs, which is invisible: the app still starts, and something
 * else that was deliberately disabled comes back.
 */
import {describe, expect, it} from 'vitest';

import {
  isWaylandSession,
  withDisabledFeature,
} from '../src/shared/chromium-flags.js';

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

describe('isWaylandSession', () => {
  it('trusts the platform Electron resolved', () => {
    expect(isWaylandSession('linux', 'wayland', {})).toBe(true);
    expect(isWaylandSession('linux', 'x11', {})).toBe(false);
  });

  it('does not mistake XWayland for Wayland', () => {
    // Electron picked x11, so the Vulkan interop path is not the one running
    // even though the session itself is Wayland.
    expect(
      isWaylandSession('linux', 'x11', {
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_SESSION_TYPE: 'wayland',
      }),
    ).toBe(false);
  });

  it('falls back to the session when the switch is absent', () => {
    expect(isWaylandSession('linux', '', {XDG_SESSION_TYPE: 'wayland'})).toBe(
      true,
    );
    expect(isWaylandSession('linux', '', {WAYLAND_DISPLAY: 'wayland-0'})).toBe(
      true,
    );
  });

  it('answers no for a session with no Wayland marker', () => {
    expect(isWaylandSession('linux', '', {DISPLAY: ':0'})).toBe(false);
  });

  it('only answers for Linux', () => {
    expect(
      isWaylandSession('darwin', 'wayland', {WAYLAND_DISPLAY: 'wayland-0'}),
    ).toBe(false);
    expect(
      isWaylandSession('win32', 'wayland', {WAYLAND_DISPLAY: 'wayland-0'}),
    ).toBe(false);
  });
});
