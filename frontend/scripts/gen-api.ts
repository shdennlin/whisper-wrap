/**
 * Regenerate the engine API client types from the checked-in contract.
 *
 * Reads `openapi-ts.config.ts` for the input contract + output path, runs
 * `openapi-typescript`, and writes the emitted `paths`/`components` `.d.ts` to
 * `src/api/generated/`. Run via `bun run gen:api`.
 *
 * The generated output is COMMITTED (design "Check in the generated client and
 * guard it against drift") so the repo type-checks offline; a future drift
 * guard (task 3.1) re-runs this and asserts the committed bytes are unchanged.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import { config } from "../openapi-ts.config";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

async function main(): Promise<void> {
  const inputPath = resolve(root, config.input);
  const outputPath = resolve(root, config.output);

  let contract: string;
  try {
    contract = readFileSync(inputPath, "utf8");
  } catch (error) {
    console.error(`gen:api — failed to read contract at ${inputPath}`);
    throw error;
  }

  const ast = await openapiTS(contract);
  // openapi-typescript emits the leading banner itself; keep a trailing newline
  // so the committed file ends cleanly.
  const contents = `${astToString(ast)}`;

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents, "utf8");
  console.log(`gen:api — wrote ${config.output}`);
}

main().catch((error) => {
  console.error("gen:api failed:", error);
  process.exit(1);
});
