/**
 * Drift guard for the generated engine API client.
 *
 * Mirrors the engine's golden-file test: regenerate the `paths`/`components`
 * types from the checked-in contract (`../docs/openapi.json`) and assert the
 * committed `src/api/generated/openapi.d.ts` is byte-identical. A contract
 * change that is not regenerated (via `bun run gen:api`) fails here, so the
 * committed client can never silently drift from the engine.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import { describe, expect, it } from "vitest";
import { config } from "../../openapi-ts.config";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("generated API client drift guard", () => {
  it("committed generated client matches a fresh generation from the contract", async () => {
    const contract = readFileSync(resolve(frontendRoot, config.input), "utf8");
    const fresh = astToString(await openapiTS(contract));
    const committed = readFileSync(resolve(frontendRoot, config.output), "utf8");
    expect(committed).toBe(fresh);
  });
});
