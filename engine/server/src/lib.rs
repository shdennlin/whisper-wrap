//! Library surface of the server crate so the desktop shell can embed
//! the exact same router in-process instead of spawning a sidecar.

pub mod ai_config;
pub mod ask;
pub mod aux_models;
pub mod history;
pub mod items;
pub mod listen;
pub mod llm;
pub mod meeting;
pub mod models;
pub mod openai;
pub mod openapi;
pub mod routes;
pub mod runs;
pub mod state;

use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

pub use llm::LlmClient;
pub use state::AppState;

/// Access log: one line per request (method, path, status, latency).
/// Static `/app/` assets log at debug so they don't drown real API
/// calls; everything else at info.
async fn access_log(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let t0 = Instant::now();
    let resp = next.run(req).await;
    let ms = t0.elapsed().as_millis();
    let status = resp.status().as_u16();
    if path.starts_with("/app/") {
        log::debug!("{method} {path} → {status} ({ms}ms)");
    } else {
        log::info!("{method} {path} → {status} ({ms}ms)");
    }
    resp
}

/// The same-origin cookie the webview uses to authenticate (set by the `/app`
/// response, presented automatically by the browser on later API/WS calls).
const TOKEN_COOKIE: &str = "engine_token";

/// Pull our token out of a `Cookie` header (`a=1; engine_token=xyz; b=2`).
fn cookie_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k.trim() == TOKEN_COOKIE).then(|| v.trim().to_owned())
    })
}

/// The `Set-Cookie` value handing the webview its token. `HttpOnly` so page
/// scripts can't read it; `SameSite=Strict` so a cross-site browser request
/// never rides it (the drive-by threat); `Path=/` so it covers every API + WS
/// path. No `Secure` — the sidecar is plain-http loopback. Returns `None` if the
/// token can't form a valid header value (rejects header injection, no panic).
fn token_cookie_header(token: &str) -> Option<axum::http::HeaderValue> {
    axum::http::HeaderValue::from_str(&format!(
        "{TOKEN_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/"
    ))
    .ok()
}

/// Optional per-launch token gate. When the desktop shell spawns the engine as
/// a sidecar it sets `ENGINE_TOKEN`; the Rust overlay presents it as a
/// `Bearer` header and the webview presents it as the same-origin cookie the
/// `/app` response hands out — so other local processes or web pages cannot
/// drive the engine. When no token is configured (self-host / web) the gate is
/// inert. `/`, `/status`, and `/app/*` stay open so the bundle loads and health
/// checks work without a token; the `/app` response is where the cookie is set.
async fn require_token(
    State(token): State<Option<Arc<str>>>,
    req: Request,
    next: Next,
) -> Response {
    // No token configured → gate is inert (self-host / web), and never sets a
    // cookie, so the gate cannot be half-enabled by accident.
    let Some(expected) = token.as_deref() else {
        return next.run(req).await;
    };
    // Keep the bundle and health checks reachable without the token. The /app
    // response additionally hands the webview its same-origin token cookie.
    // `/openapi.json` and `/docs` are exempt UNCONDITIONALLY (not under
    // `cfg(debug_assertions)`): in a debug build the request reaches the live
    // route (200), in a release build the compiled-out route falls through to a
    // router 404 — so the gate never returns 401 for these paths in any build.
    let path = req.uri().path().to_owned();
    if path == "/"
        || path == "/status"
        || path == "/openapi.json"
        || path == "/docs"
        || path.starts_with("/app")
    {
        let mut resp = next.run(req).await;
        if path.starts_with("/app") {
            if let Some(cookie) = token_cookie_header(expected) {
                resp.headers_mut()
                    .append(axum::http::header::SET_COOKIE, cookie);
            }
        }
        return resp;
    }
    // Accept the token from the overlay's Bearer header OR the webview's cookie.
    let bearer = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_owned());
    let presented = bearer.or_else(|| cookie_token(req.headers()));
    match presented {
        Some(t) if ct_eq(t.as_bytes(), expected.as_bytes()) => next.run(req).await,
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

/// Constant-time byte comparison so the token check does not leak its contents
/// via early-mismatch timing. Dependency-free; length is not itself secret.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Build the full HTTP router. `frontend_dir`, when it exists, is
/// mounted at /app/ (the PWA bundle).
pub fn build_router(state: Arc<AppState>, frontend_dir: Option<&str>) -> Router {
    // Captured before `state` is moved into `with_state` below.
    let engine_token: Option<Arc<str>> = state.config.engine_token.as_deref().map(Arc::from);
    // Body-size limit stays INNERMOST — applied before `.with_state()` so
    // `require_token` runs before the size check and an unauthenticated
    // oversized request returns 401, not 413 (load-bearing; do not reorder).
    let body_limit = axum::extract::DefaultBodyLimit::max(
        (state.config.max_file_size_bytes() + 1024 * 1024) as usize,
    );
    // Single source of truth: the 49 API routes and the OpenAPI document are
    // assembled together on an `OpenApiRouter`, then `split_for_parts()` yields
    // the plain `Router` (for the static mount, doc routes, and middleware) plus
    // the generated `OpenApi`. `_api` is unused in release builds (the doc
    // routes below are compiled out), hence the underscore.
    let (router, _api) = openapi::api_router().layer(body_limit).split_for_parts();
    let mut app: Router = router.with_state(state);

    // Doc routes are DEBUG-ONLY: present under `make dev` / `cargo test`,
    // compiled out of release builds (`make server` / `make desktop` / `make
    // up`), where both paths fall through to a 404. Spec assembly above still
    // runs in every build (only these two serving routes are conditional). They
    // are attached to the plain `Router` after `split_for_parts()`, so they are
    // absent from the generated document — matching the `/app` static mount.
    #[cfg(debug_assertions)]
    {
        use utoipa_scalar::{Scalar, Servable};
        let api = _api.clone();
        app = app
            .route(
                "/openapi.json",
                axum::routing::get(move || std::future::ready(axum::Json(api.clone()))),
            )
            .merge(Scalar::with_url("/docs", _api));
    }

    if let Some(dir) = frontend_dir {
        if std::path::Path::new(dir).is_dir() {
            app = app.nest_service(
                "/app",
                ServeDir::new(dir).append_index_html_on_directories(true),
            );
        } else {
            log::warn!("frontend dir {dir:?} missing — /app/ not mounted");
        }
    }
    // Layer order (innermost → outermost): token gate, then CORS, then access
    // log. CORS MUST wrap the token gate: a cross-origin POST/PATCH from the
    // desktop overlay's local asset origin triggers a preflight `OPTIONS` that
    // carries no Authorization header (or cookie), so if the gate ran first it
    // would 401 the preflight and silently block every overlay persistence call.
    // CorsLayer short-circuits the preflight before `require_token` ever runs.
    // The allowlist is the per-OS Tauri asset origin (macOS WKWebView vs Windows
    // WebView2); the gate is still inert when no token is configured, so
    // self-host / web behavior is unchanged.
    app.layer(axum::middleware::from_fn_with_state(
        engine_token,
        require_token,
    ))
    .layer(overlay_cors())
    .layer(axum::middleware::from_fn(access_log))
}

/// CORS allowance for the desktop overlay surface, which calls the engine from a
/// LOCAL custom-scheme origin (not the engine's `/app` origin) and authenticates
/// with a Bearer token rather than the same-origin cookie. The desktop shell
/// serves the private overlay bundle under its own `wwoverlay` URI scheme, whose
/// per-OS origin is allowlisted here; this answers the `Authorization` /
/// `Content-Type` preflight the session-persistence + audio-upload calls send.
fn overlay_cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin([
            // macOS WKWebView custom-scheme origin.
            HeaderValue::from_static("wwoverlay://localhost"),
            // Windows WebView2 custom-scheme origin.
            HeaderValue::from_static("http://wwoverlay.localhost"),
        ])
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt;

    fn guarded(token: Option<Arc<str>>) -> Router {
        Router::new()
            .route("/v1/x", get(|| async { "ok" }))
            .route("/status", get(|| async { "ok" }))
            .route("/app/index.html", get(|| async { "doc" }))
            .layer(axum::middleware::from_fn_with_state(token, require_token))
    }

    async fn code_of(router: Router, req: Request) -> StatusCode {
        router.oneshot(req).await.unwrap().status()
    }

    /// Mirrors the production layering for the overlay's cross-origin calls:
    /// token gate (inner) wrapped by CORS (outer).
    fn guarded_with_cors(token: Option<Arc<str>>) -> Router {
        Router::new()
            .route("/v1/x", get(|| async { "ok" }).post(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(token, require_token))
            .layer(overlay_cors())
    }

    #[tokio::test]
    async fn cors_preflight_is_answered_before_the_token_gate() {
        // The gate would 401 an unauthenticated request, but a preflight OPTIONS
        // carries no token — CORS must short-circuit it before the gate runs.
        let resp = guarded_with_cors(Some(Arc::from("secret")))
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/v1/x")
                    .header("origin", "wwoverlay://localhost")
                    .header("access-control-request-method", "POST")
                    .header("access-control-request-headers", "authorization,content-type")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            resp.status().is_success(),
            "preflight must not be 401'd by the token gate"
        );
        assert_eq!(
            resp.headers().get("access-control-allow-origin").unwrap(),
            "wwoverlay://localhost"
        );
    }

    #[tokio::test]
    async fn cors_echoes_the_allowed_overlay_origin_on_real_requests() {
        // A real POST still needs the token; the response must carry the allowed
        // origin header so the browser exposes the response to the surface.
        let resp = guarded_with_cors(Some(Arc::from("secret")))
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/x")
                    .header("origin", "wwoverlay://localhost")
                    .header(axum::http::header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().is_success());
        assert_eq!(
            resp.headers().get("access-control-allow-origin").unwrap(),
            "wwoverlay://localhost"
        );
    }

    #[tokio::test]
    async fn no_token_configured_allows_all() {
        let r = guarded(None);
        assert_eq!(
            code_of(r, Request::get("/v1/x").body(Body::empty()).unwrap()).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn token_configured_rejects_missing_and_wrong_bearer() {
        let r = guarded(Some(Arc::from("secret")));
        assert_eq!(
            code_of(
                r.clone(),
                Request::get("/v1/x").body(Body::empty()).unwrap()
            )
            .await,
            StatusCode::UNAUTHORIZED,
            "missing token is rejected"
        );
        assert_eq!(
            code_of(
                r,
                Request::get("/v1/x")
                    .header("authorization", "Bearer nope")
                    .body(Body::empty())
                    .unwrap()
            )
            .await,
            StatusCode::UNAUTHORIZED,
            "wrong token is rejected"
        );
    }

    #[tokio::test]
    async fn token_configured_allows_correct_bearer() {
        let r = guarded(Some(Arc::from("secret")));
        assert_eq!(
            code_of(
                r,
                Request::get("/v1/x")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap()
            )
            .await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn status_is_exempt_even_with_token() {
        let r = guarded(Some(Arc::from("secret")));
        assert_eq!(
            code_of(r, Request::get("/status").body(Body::empty()).unwrap()).await,
            StatusCode::OK,
            "/status stays open so health checks work without a token"
        );
    }

    #[tokio::test]
    async fn token_configured_allows_correct_cookie() {
        // The webview presents the token as a same-origin cookie, not a bearer.
        let r = guarded(Some(Arc::from("secret")));
        assert_eq!(
            code_of(
                r,
                Request::get("/v1/x")
                    .header("cookie", "other=1; engine_token=secret; more=2")
                    .body(Body::empty())
                    .unwrap()
            )
            .await,
            StatusCode::OK,
            "a valid engine_token cookie authenticates the webview"
        );
    }

    #[tokio::test]
    async fn token_configured_rejects_wrong_cookie() {
        let r = guarded(Some(Arc::from("secret")));
        assert_eq!(
            code_of(
                r,
                Request::get("/v1/x")
                    .header("cookie", "engine_token=nope")
                    .body(Body::empty())
                    .unwrap()
            )
            .await,
            StatusCode::UNAUTHORIZED,
            "a wrong cookie is rejected"
        );
    }

    #[tokio::test]
    async fn app_response_sets_httponly_samesite_token_cookie() {
        // The /app document hands the webview its token cookie so subsequent
        // same-origin API/WS calls authenticate without a frontend change.
        let r = guarded(Some(Arc::from("secret")));
        let resp = r
            .oneshot(Request::get("/app/index.html").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let set = resp
            .headers()
            .get(axum::http::header::SET_COOKIE)
            .expect("a token cookie is set on the /app response")
            .to_str()
            .unwrap();
        assert!(set.contains("engine_token=secret"), "cookie carries the token: {set}");
        assert!(set.contains("HttpOnly"), "cookie is HttpOnly: {set}");
        assert!(set.contains("SameSite=Strict"), "cookie is SameSite=Strict: {set}");
    }

    #[tokio::test]
    async fn inert_gate_sets_no_cookie_on_app() {
        // Self-host (no ENGINE_TOKEN) stays fully inert: no token cookie is
        // ever handed out, so the gate cannot be half-enabled by accident.
        let r = guarded(None);
        let resp = r
            .oneshot(Request::get("/app/index.html").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(
            resp.headers().get(axum::http::header::SET_COOKIE).is_none(),
            "no token cookie when the gate is inert"
        );
    }
}
