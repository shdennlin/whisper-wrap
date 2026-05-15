/**
 * Minimal AudioWorkletProcessor type declarations.
 *
 * The standard `lib.dom.d.ts` does not include the AudioWorklet globals because
 * they live in a separate global scope (the AudioWorklet thread). We declare
 * what `audio-worklet.ts` uses so TypeScript can type-check it.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

declare const sampleRate: number;

declare module "*?url" {
  const url: string;
  export default url;
}
