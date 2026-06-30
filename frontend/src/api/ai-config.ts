/**
 * AI-provider config client (ai-provider-settings).
 *
 * Wraps the engine's four `/config/ai` endpoints. The wire shape is camelCase
 * and the raw API key is NEVER returned on reads — a read exposes only
 * `keySet` + a short masked `keyHint`. On a save an empty `apiKey` means "keep
 * the stored key"; the caller is responsible for sending `""` rather than the
 * masked hint when the user leaves the key field blank.
 *
 * Every method is `fetch`-injectable so vitest can stub the network without a
 * real server.
 */

export type AiProvider = "gemini" | "openai-compatible";

/** Masked config returned by `GET` / `PUT` — never carries the raw key. */
export interface AiConfigView {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  keySet: boolean;
  keyHint: string;
  systemPromptSet: boolean;
}

/** Body sent to `PUT /config/ai`. Empty `apiKey` keeps the stored key. */
export interface AiConfigUpdate {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  systemPrompt?: string;
}

/** Candidate config used for model discovery / connection test (no persist). */
export interface AiConfigProbe {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AiModelsResult {
  models: string[];
  error: string | null;
}

export interface AiTestResult {
  ok: boolean;
  error: string | null;
}

/** A `fetch`-compatible function; defaults to the global `fetch`. */
export type FetchLike = typeof fetch;

function resolveFetch(f?: FetchLike): FetchLike {
  if (f) return f;
  if (typeof fetch === "function") return fetch;
  throw new Error("no fetch available");
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** GET the resolved config with the key masked. */
export async function getAiConfig(fetchImpl?: FetchLike): Promise<AiConfigView> {
  const f = resolveFetch(fetchImpl);
  const r = await f("/config/ai");
  if (!r.ok) throw new Error(`get ai config failed: ${r.status}`);
  return (await r.json()) as AiConfigView;
}

/** Save the config + swap the live client; returns the new masked view. */
export async function putAiConfig(
  update: AiConfigUpdate,
  fetchImpl?: FetchLike,
): Promise<AiConfigView> {
  const f = resolveFetch(fetchImpl);
  const r = await f("/config/ai", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(update),
  });
  if (!r.ok) throw new Error(`save ai config failed: ${r.status}`);
  return (await r.json()) as AiConfigView;
}

/**
 * List provider models for a candidate config. Network/auth failures come back
 * as `{ models: [], error }` (a 200, never a thrown error) so the UI can keep
 * offering custom free-text entry.
 */
export async function listAiModels(
  probe: AiConfigProbe,
  fetchImpl?: FetchLike,
): Promise<AiModelsResult> {
  const f = resolveFetch(fetchImpl);
  const params = new URLSearchParams({
    provider: probe.provider,
    baseUrl: probe.baseUrl,
    apiKey: probe.apiKey,
  });
  const r = await f(`/config/ai/models?${params.toString()}`);
  if (!r.ok) throw new Error(`list ai models failed: ${r.status}`);
  return (await r.json()) as AiModelsResult;
}

/** Validate a candidate config with one minimal request (does not persist). */
export async function testAiConfig(
  probe: AiConfigProbe,
  fetchImpl?: FetchLike,
): Promise<AiTestResult> {
  const f = resolveFetch(fetchImpl);
  const r = await f("/config/ai/test", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(probe),
  });
  if (!r.ok) throw new Error(`test ai config failed: ${r.status}`);
  return (await r.json()) as AiTestResult;
}
