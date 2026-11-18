import {describe, expect, it} from 'vitest';

import {
  audioInputs,
  labelFor,
  resolveSavedDevice,
} from '../src/renderer/voice-devices.js';

function device(
  deviceId: string,
  label: string,
  kind: MediaDeviceKind = 'audioinput',
): MediaDeviceInfo {
  return {
    deviceId,
    groupId: 'g',
    kind,
    label,
    toJSON: () => ({}),
  } as MediaDeviceInfo;
}

const DEVICES = [
  device('mic-1', 'Desk mic'),
  device('speaker', 'Speakers', 'audiooutput'),
  device('mic-2', ''),
];

describe('audioInputs', () => {
  it('keeps only inputs and names an unlabelled one', () => {
    expect(audioInputs(DEVICES)).toEqual([
      {deviceId: 'mic-1', label: 'Desk mic'},
      {deviceId: 'mic-2', label: 'Microphone 2'},
    ]);
  });
});

describe('resolveSavedDevice', () => {
  it('uses the saved microphone when it is still there', () => {
    expect(resolveSavedDevice(audioInputs(DEVICES), 'mic-1')).toEqual({
      selected: 'mic-1',
      missing: false,
    });
  });

  it('falls back to the system default when the saved one is gone', () => {
    expect(resolveSavedDevice(audioInputs(DEVICES), 'unplugged')).toEqual({
      selected: null,
      missing: true,
    });
  });

  it('treats no saved id as the system default, not as a missing device', () => {
    expect(resolveSavedDevice(audioInputs(DEVICES), null)).toEqual({
      selected: null,
      missing: false,
    });
  });
});

describe('labelFor', () => {
  it('finds the friendly name while the device is present', () => {
    expect(labelFor(audioInputs(DEVICES), 'mic-1')).toBe('Desk mic');
    expect(labelFor(audioInputs(DEVICES), 'gone')).toBeNull();
    expect(labelFor(audioInputs(DEVICES), null)).toBeNull();
  });
});
