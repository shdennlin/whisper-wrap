/**
 * Live session-change subscription (live-library-push).
 *
 * Opens one long-lived `EventSource` against the backend's `/v1/sessions/events`
 * SSE stream and calls `onChange` whenever the server emits a `changed` event —
 * i.e. a session was created or finalized by ANY client (this window, another
 * tab, an external Shortcut/curl, or the desktop overlay). The caller wires
 * `onChange` to the shared all-surfaces refresh.
 *
 * `EventSource` reconnects automatically on a dropped connection; we treat each
 * reconnection (every `open` after the first) as a cue to run one catch-up
 * refresh, since `changed` pings emitted while we were disconnected are not
 * replayed. The whole thing degrades to a no-op where `EventSource` is absent
 * (e.g. a non-browser host), so startup never throws.
 *
 * Events carry no session data — they are pure "re-fetch" pings; the refresh
 * re-reads via the existing list/store paths.
 */

export interface SessionEventsDeps {
  /** Called on each `changed` event and once after every reconnect. */
  onChange: () => void;
  /** Stream URL; defaults to a same-origin `/v1/sessions/events`. */
  url?: string;
  /** Injectable constructor for tests; defaults to the global `EventSource`. */
  EventSourceCtor?: typeof EventSource;
}

const DEFAULT_URL = "/v1/sessions/events";

/**
 * Start the subscription. Returns an unsubscribe function that closes the
 * stream and prevents any further `onChange` calls. Safe to call the returned
 * function more than once.
 */
export function subscribeSessionEvents(deps: SessionEventsDeps): () => void {
  const Ctor =
    deps.EventSourceCtor ??
    (typeof EventSource !== "undefined" ? EventSource : undefined);
  // No EventSource (non-browser host / disabled): nothing to subscribe to.
  if (!Ctor) return () => {};

  const url = deps.url ?? DEFAULT_URL;
  const es = new Ctor(url);
  let connectedOnce = false;
  let stopped = false;

  es.addEventListener("changed", () => {
    if (!stopped) deps.onChange();
  });

  es.addEventListener("open", () => {
    if (stopped) return;
    // First open is the initial connect — the window already loaded its data,
    // so no catch-up is needed. Every later open is a reconnect: run one
    // refresh to pick up changes missed while the stream was down.
    if (connectedOnce) deps.onChange();
    connectedOnce = true;
  });

  return () => {
    stopped = true;
    es.close();
  };
}
