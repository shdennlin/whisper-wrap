/**
 * Dictionary config client (zh-convert-dictionary).
 *
 * Wraps the engine's two `/config/dictionary` endpoints. The wire shape is
 * snake_case (`zh_convert`), mirroring the on-disk dictionary document —
 * read and write shapes are identical by design (no secrets to mask here).
 * A PUT replaces the full document; the engine validates it (mode, non-empty
 * `from` after trimming, table cap) and a 400 carries the standard ApiError
 * body `{ "detail": string }`, which this module surfaces in the thrown
 * Error's message so the settings UI can show it verbatim.
 *
 * Transport + the swappable test `fetch` seam live in the shared generated
 * client (`./client`); this module composes calls onto it. Tests stub the
 * client's ONE `fetch` (`setClientFetch`) and assert on the emitted `Request`.
 */

import { client } from "./client";
import type { components } from "./generated/openapi";

// Shapes derive from the generated contract so field names/types cannot
// drift from the engine's schema; re-exported for the settings UI.
export type DictionaryConfig = components["schemas"]["DictionaryConfig"];
export type ReplacementPair = components["schemas"]["ReplacementPair"];

/**
 * Build the thrown message for a non-ok response: prefer the engine's
 * ApiError `detail` (e.g. a validation failure like
 * "replacements[0].from must be non-empty after trimming"), fall back to
 * the status code.
 */
function failureMessage(
  op: string,
  error: unknown,
  response: Response,
): string {
  const detail =
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof (error as { detail: unknown }).detail === "string"
      ? (error as { detail: string }).detail
      : null;
  return detail
    ? `${op} failed: ${detail}`
    : `${op} failed: ${response.status}`;
}

/** GET the current effective dictionary config. */
export async function getDictionaryConfig(): Promise<DictionaryConfig> {
  const { data, error, response } = await client.GET("/config/dictionary");
  if (!response.ok || !data) {
    throw new Error(failureMessage("get dictionary config", error, response));
  }
  return data;
}

/** PUT the full config document; returns the stored config. */
export async function putDictionaryConfig(
  cfg: DictionaryConfig,
): Promise<DictionaryConfig> {
  const { data, error, response } = await client.PUT("/config/dictionary", {
    body: cfg,
  });
  if (!response.ok || !data) {
    throw new Error(failureMessage("save dictionary config", error, response));
  }
  return data;
}
