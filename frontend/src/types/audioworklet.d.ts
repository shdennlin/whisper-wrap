/**
 * Module shim for Vite's `?url` import suffix. The worklet itself is plain
 * `.js` (see `capture/audio-worklet.js`) so the AudioWorkletProcessor globals
 * no longer need TypeScript declarations.
 */

declare module "*?url" {
  const url: string;
  export default url;
}
