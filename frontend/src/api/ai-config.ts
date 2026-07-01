/**
 * AI-provider config client (ai-provider-settings).
 *
 * Wraps the engine's four `/config/ai` endpoints. The wire shape is camelCase
 * and the raw API key is NEVER returned on reads — a read exposes only
 * `keySet` + a short masked `keyHint`. On a save an empty `apiKey` means "keep
 * the stored key"; the caller is responsible for sending `""` rather than the
 * masked hint when the user leaves the key field blank.
 *
 * Transport + the swappable test `fetch` seam live in the shared generated
 * client (`./client`); this module composes calls onto it. It no longer takes
 * a per-call `fetchImpl` — tests stub the client's ONE `fetch` (`setClientFetch`)
 * and assert on the emitted `Request`.
 */

import { client } from "./client";
import type { components } from "./generated/openapi";

/** Provider ids the UI offers (the wire `provider` is a plain string). */
export type AiProvider = "gemini" | "openai-compatible";

// The old hand-written `AiConfigView` / `AiConfigUpdate` / `AiTestResult`
// interfaces are deleted; these names now derive from the generated contract
// types so field names/types cannot drift from the engine's schema. They are
// re-exported under the same names so existing consumers keep resolving them
// from this module.
export type AiConfigView = components["schemas"]["AiConfigView"];
export type AiTestResult = components["schemas"]["AiTestResult"];
// The engine accepts a partial update (every field optional on the wire), but
// the AI-provider form always submits provider/baseUrl/model/apiKey together —
// so we keep those required on the frontend's update type (matching the deleted
// hand-written interface) while sourcing the field types from the contract.
export type AiConfigUpdate = components["schemas"]["AiConfigUpdate"] &
  Required<
    Pick<components["schemas"]["AiConfigUpdate"], "baseUrl" | "model" | "apiKey">
  >;

/**
 * Result of the AI-provider model passthrough (`GET /config/ai/models`).
 *
 * The ONE hand-kept response shape in this module: `engine-response-typing`
 * documents the model passthrough as a dynamic exception, so the generated
 * contract leaves its 200 body open (`content?: never`). The call site casts
 * the open response to this shape — see `listAiModels`.
 */
export interface AiModelsResult {
  models: string[];
  error: string | null;
}

/** Candidate config used for model discovery / connection test (no persist). */
interface AiConfigProbe {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** GET the resolved config with the key masked. */
export async function getAiConfig(): Promise<AiConfigView> {
  const { data, response } = await client.GET("/config/ai");
  if (!response.ok || !data) {
    throw new Error(`get ai config failed: ${response.status}`);
  }
  return data;
}

/** Save the config + swap the live client; returns the new masked view. */
export async function putAiConfig(update: AiConfigUpdate): Promise<AiConfigView> {
  const { data, response } = await client.PUT("/config/ai", { body: update });
  if (!response.ok || !data) {
    throw new Error(`save ai config failed: ${response.status}`);
  }
  return data;
}

/**
 * List provider models for a candidate config. Network/auth failures come back
 * as `{ models: [], error }` (a 200, never a thrown error) so the UI can keep
 * offering custom free-text entry.
 */
export async function listAiModels(probe: AiConfigProbe): Promise<AiModelsResult> {
  const { data, response } = await client.GET("/config/ai/models", {
    params: {
      query: {
        provider: probe.provider,
        baseUrl: probe.baseUrl,
        apiKey: probe.apiKey,
      },
    },
  });
  if (!response.ok) {
    throw new Error(`list ai models failed: ${response.status}`);
  }
  // DYNAMIC EXCEPTION (design "Cast only the documented dynamic exceptions"):
  // `GET /config/ai/models` is the AI-provider passthrough — the generated
  // contract leaves its 200 body open (`content?: never`), so `data` is untyped
  // here. This is the one local response assertion allowed in this module: cast
  // the open response to the hand-kept models-result shape.
  return data as unknown as AiModelsResult;
}

/** Validate a candidate config with one minimal request (does not persist). */
export async function testAiConfig(probe: AiConfigProbe): Promise<AiTestResult> {
  const { data, response } = await client.POST("/config/ai/test", {
    body: {
      provider: probe.provider,
      baseUrl: probe.baseUrl,
      model: probe.model,
      apiKey: probe.apiKey,
    },
  });
  if (!response.ok || !data) {
    throw new Error(`test ai config failed: ${response.status}`);
  }
  return data;
}
