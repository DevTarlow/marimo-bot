/**
 * The Electron half of secret storage: the cipher.
 *
 * `@marimo/runtime`'s `FileSecretStore` owns the file format and the
 * three-valued read. All this file supplies is the encryption itself, which only
 * Electron has. There used to be a second export here for a provider's API key;
 * the models are local now and need no key, so the store is only ever a
 * connector's secret.
 */
import {safeStorage} from 'electron';

import {FileSecretStore} from '@marimo/runtime';
import type {SecretCipher} from '@marimo/runtime';

export const safeStorageCipher: SecretCipher = {
  available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      // A keychain that throws is a keychain that is not there — on Linux, a
      // session with no D-Bus or no secret service.
      return false;
    }
  },
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (payload) => safeStorage.decryptString(payload),
};

/** The store for one secret file, with the OS keychain behind it. */
export function secretStore(file: string, label: string): FileSecretStore {
  return new FileSecretStore(file, label, safeStorageCipher);
}
