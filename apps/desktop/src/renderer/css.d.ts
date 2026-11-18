/**
 * Stylesheets are imported for their side effect and handled by Vite.
 *
 * This file deliberately has no imports and no exports: a `declare module` in a
 * file that is a module becomes a module *augmentation*, which requires the
 * module to already exist — so the declaration would be checked against nothing
 * and fail. As a script, it is an ambient declaration, which is what a bundler
 * asset needs.
 */
declare module '*.css';

/**
 * Vite's `?url` import: the emitted asset's URL, used for the AudioWorklet
 * module. The worklet is a separate file so the packaged window can load it
 * under `script-src 'self' file:` without adding `blob:` to the policy.
 */
declare module '*?url&no-inline' {
  const url: string;
  export default url;
}

declare module '*?url' {
  const url: string;
  export default url;
}
