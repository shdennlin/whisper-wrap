/**
 * Mocked-backend route interception for the `mocked` Playwright project
 * (fe-e2e-playwright). Installs `page.route` handlers that answer the engine
 * endpoints with fixtures, so UI flows run deterministically with no real
 * server or model.
 */

import type { Page, Route } from "@playwright/test";
import {
  ACTIONS,
  MEETINGS,
  MODELS,
  SESSIONS,
  STATUS,
  type SessionFull,
} from "../fixtures/data";

export interface MockOptions {
  sessions?: SessionFull[];
  meetings?: unknown[];
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * Install fixture handlers for every endpoint the app touches on load and in
 * the core flows. Returns a `calls` accessor so specs can assert which
 * mutating requests were issued (e.g. a star PATCH, a delete).
 */
export async function mockBackend(
  page: Page,
  opts: MockOptions = {},
): Promise<{ calls: { method: string; url: string }[] }> {
  // A mutable working copy so DELETE/PATCH are reflected by later list GETs.
  const sessions = (opts.sessions ?? SESSIONS).map((s) => ({ ...s }));
  const meetings = opts.meetings ?? MEETINGS;
  const calls: { method: string; url: string }[] = [];

  // POST /transcribe → a canned transcript (overlay/recording capture path).
  await page.route(/\/transcribe(\?.*)?$/, (route) =>
    json(route, { text: "hello world" }),
  );

  // Item sub-resources. The generic route is registered FIRST so the specific
  // /runs route (registered last) wins by Playwright's last-registered-wins
  // precedence. The unified detail view loads runs from /items/<id>/runs
  // (listItemRuns) and expects a { runs: [...] } shape — it THROWS on a non-ok
  // or wrong-shaped response, which would abort the detail render before the
  // finals fallback. Empty runs → the view falls back to the finals transcript.
  await page.route(/\/items\/[^/?]+(\/[^?]+)?(\?.*)?$/, (route) =>
    json(route, {}),
  );
  await page.route(/\/items\/[^/?]+\/runs(\?.*)?$/, (route) => {
    // unify-run-ledger: the backend synthesizes a read-only `capture`
    // transcribe run from a session's finals, so the detail view reads its
    // transcript from the runs list (no longer from session.finals). Mirror
    // that here — a session with finals yields one done, segment-shaped
    // transcribe run; an empty session yields no runs (empty detail state).
    const id = route.request().url().split("/items/")[1].split(/[/?]/)[0];
    const session = sessions.find((s) => s.id === id);
    const finals = session?.finals ?? [];
    const runs =
      finals.length > 0
        ? [
            {
              id: `${id}-capture`,
              item_id: id,
              kind: "transcribe",
              model: null,
              status: "done",
              progress: 1,
              stage: null,
              result_ref: null,
              error: null,
              created_at: session?.started_at ?? 0,
              updated_at: session?.started_at ?? 0,
              result: {
                segments: finals.map((f) => ({
                  text: f.text,
                  start: (f.start_ms ?? 0) / 1000,
                })),
              },
              origin: "capture",
            },
          ]
        : [];
    return json(route, { runs });
  });

  // Session sub-resources (/v1/sessions/<id>/finals, /runs, /audio). /runs is
  // an array (empty → detail falls back to the finals transcript); others → {}.
  await page.route(/\/v1\/sessions\/[^/?]+\/[^?]+(\?.*)?$/, (route) => {
    const req = route.request();
    calls.push({ method: req.method(), url: req.url() });
    if (/\/runs(\?.*)?$/.test(req.url())) return json(route, []);
    return json(route, {});
  });

  // Session by id: GET → detail, PATCH → update, DELETE → remove (so the
  // working copy reflects the mutation for later list GETs).
  await page.route(/\/v1\/sessions\/([^/?]+)(\?.*)?$/, (route) => {
    const req = route.request();
    const method = req.method();
    calls.push({ method, url: req.url() });
    const id = req.url().split("/v1/sessions/")[1].split(/[/?]/)[0];
    const idx = sessions.findIndex((s) => s.id === id);
    if (method === "GET") {
      return json(route, idx >= 0 ? sessions[idx] : sessions[0]);
    }
    if (method === "DELETE") {
      if (idx >= 0) sessions.splice(idx, 1);
      return json(route, {});
    }
    if (method === "PATCH" && idx >= 0) {
      const body = (req.postDataJSON() ?? {}) as Partial<SessionFull>;
      sessions[idx] = { ...sessions[idx], ...body };
    }
    return json(route, {});
  });

  // Session list (GET) + create (POST).
  await page.route(/\/v1\/sessions(\?.*)?$/, (route) => {
    const req = route.request();
    const method = req.method();
    calls.push({ method, url: req.url() });
    if (method === "POST") {
      return json(route, { id: "sess-new", started_at: Date.now() });
    }
    return json(route, { sessions, next_before_ms: null });
  });

  // Meetings list + by id.
  await page.route(/\/v1\/meetings\/[^/?]+(\?.*)?$/, (route) =>
    json(route, {}),
  );
  await page.route(/\/v1\/meetings(\?.*)?$/, (route) =>
    json(route, { meetings, next_before_ms: null }),
  );

  // Discovery/config endpoints.
  await page.route(/\/actions(\?.*)?$/, (route) => json(route, ACTIONS));
  await page.route(/\/status(\?.*)?$/, (route) => json(route, STATUS));
  await page.route(/\/models(\?.*)?$/, (route) => json(route, MODELS));

  return { calls };
}
