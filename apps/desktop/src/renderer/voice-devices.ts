/**
 * The microphone list, and what to do when the saved one is gone.
 *
 * `enumerateDevices` is a browser fact and this is the pure part of it: which
 * entries are inputs, which one a stored id resolves to, and whether the stored
 * id is missing. Keeping the decision here means the hook does not have to guess
 * between "the person chose the default" and "the device they chose is
 * unplugged", which are different sentences on the card.
 */

/** One input device, as the card draws it. */
export interface AudioInput {
  deviceId: string;
  label: string;
}

/** Every audio input in an `enumerateDevices` answer, in the order given. */
export function audioInputs(
  devices: readonly MediaDeviceInfo[],
): AudioInput[] {
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      // Before permission the label is blank; a numbered placeholder is still a
      // list somebody can choose from, and it gains the real name after the
      // first test.
      label: device.label || `Microphone ${String(index + 1)}`,
    }));
}

/**
 * What the dropdown should select.
 *
 * A saved id that is present is used. A saved id that is absent falls back to
 * the OS default — but `missing` is true, because the card has to say that the
 * old microphone is unplugged rather than silently moving the person's choice.
 */
export function resolveSavedDevice(
  inputs: readonly AudioInput[],
  savedId: string | null,
): {selected: string | null; missing: boolean} {
  if (savedId === null) {
    return {selected: null, missing: false};
  }
  if (inputs.some((input) => input.deviceId === savedId)) {
    return {selected: savedId, missing: false};
  }
  return {selected: null, missing: true};
}

/** The friendly name of a device, when the list still has it. */
export function labelFor(
  inputs: readonly AudioInput[],
  deviceId: string | null,
): string | null {
  if (deviceId === null) {
    return null;
  }
  return inputs.find((input) => input.deviceId === deviceId)?.label ?? null;
}
