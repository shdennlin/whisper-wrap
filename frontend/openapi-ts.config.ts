/**
 * Codegen configuration for the engine API client.
 *
 * The generator (`scripts/gen-api.ts`, wired to `bun run gen:api`) reads the
 * tightened engine contract from `../docs/openapi.json` and emits a single
 * `paths`/`components` `.d.ts` into `src/api/generated/`. That subdirectory is
 * a DEDICATED home for generated output — kept out of the hand-written
 * `src/api/client.ts` + `ai-config.ts` — and is exempted from Biome lint (see
 * `biome.json` `files.includes`) so generator formatting never fights the
 * repo style and the drift guard's byte comparison stays authoritative.
 *
 * Paths are resolved relative to this file's directory (the frontend root).
 */
export interface OpenApiCodegenConfig {
  /** The engine contract, the single source of truth for the client types. */
  readonly input: string;
  /** Where the generated `paths`/`components` `.d.ts` is written. */
  readonly output: string;
}

export const config: OpenApiCodegenConfig = {
  input: "../docs/openapi.json",
  output: "src/api/generated/openapi.d.ts",
};

export default config;
