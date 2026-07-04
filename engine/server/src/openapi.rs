//! OpenAPI 3.1 spec assembly for the engine server.
//!
//! Route registration and spec collection share one source of truth: every
//! API route is wired through `utoipa_axum::router::OpenApiRouter` via
//! `routes!()`, which forces a `#[utoipa::path]` on each handler by
//! construction — a route registered this way cannot silently miss the spec.
//! `build_router()` (in `lib.rs`) calls [`api_router`], applies the body-size
//! limit, and `split_for_parts()`s to recover the plain `axum::Router` (for the
//! static `/app` mount, the doc routes, and the cross-cutting middleware) plus
//! the assembled `OpenApi` document (served at `/openapi.json` and `/docs` in
//! debug builds, and dumped to a checked-in `docs/openapi.json`).

use std::sync::Arc;

use utoipa::openapi::security::{
    ApiKey, ApiKeyValue, HttpAuthScheme, HttpBuilder, SecurityRequirement, SecurityScheme,
};
use utoipa::{Modify, OpenApi};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::state::AppState;

/// Registers the `engine_token` auth in the assembled document. utoipa emits
/// neither the security scheme(s) nor a global `security` requirement
/// automatically, so without this the empty per-operation `security([])`
/// markers on `GET /` and `GET /status` would be no-ops and token-gated routes
/// would show no security at all.
///
/// `require_token` (in `lib.rs`) accepts **either** an `Authorization: Bearer`
/// header **or** an `engine_token` cookie. A single OpenAPI security scheme
/// object is exactly one type, so the two auth alternatives are registered as
/// two distinct schemes and expressed as independent (OR) alternatives in the
/// global `security` array — a client may satisfy either.
struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "engine_token_bearer",
            SecurityScheme::Http(HttpBuilder::new().scheme(HttpAuthScheme::Bearer).build()),
        );
        components.add_security_scheme(
            "engine_token_cookie",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::new("engine_token"))),
        );
        // Two separate requirement objects → OR alternatives (bearer or cookie),
        // inherited by every documented route that does not opt out via an
        // empty per-operation `security([])`.
        openapi.security = Some(vec![
            SecurityRequirement::new("engine_token_bearer", Vec::<&str>::new()),
            SecurityRequirement::new("engine_token_cookie", Vec::<&str>::new()),
        ]);
    }
}

/// Base document metadata plus the `engine_token` security modifier (see
/// [`SecurityAddon`]).
#[derive(OpenApi)]
#[openapi(
    info(
        title = "whisper-wrap engine API",
        description = "HTTP/WebSocket/SSE API for the whisper-wrap transcription engine."
    ),
    modifiers(&SecurityAddon)
)]
pub struct ApiDoc;

/// The `OpenApiRouter` carrying all 49 API routes (method+path pairs across 37
/// unique paths). Each `routes!()` call groups a single path's methods; the
/// handler's `#[utoipa::path]` supplies method + path, so registration and
/// documentation stay coupled. The doc-serving routes (`/openapi.json`,
/// `/docs`) and the static `/app` mount are intentionally NOT registered here —
/// they are attached to the plain `Router` after `split_for_parts()`, so they
/// are absent from the generated document by construction.
pub fn api_router() -> OpenApiRouter<Arc<AppState>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        // Core transcription / QA
        .routes(routes!(crate::routes::transcribe))
        .routes(routes!(crate::listen::listen))
        .routes(routes!(crate::ask::ask))
        .routes(routes!(crate::meeting::submit))
        .routes(routes!(crate::meeting::poll, crate::meeting::cancel))
        // Items / runs
        .routes(routes!(crate::runs::get_run))
        .routes(routes!(crate::items::items_transcribe))
        .routes(routes!(crate::items::items_diarize))
        .routes(routes!(crate::items::items_ai))
        .routes(routes!(crate::runs::list_item_runs))
        // OpenAI-compat
        .routes(routes!(crate::openai::transcriptions))
        .routes(routes!(crate::openai::translations))
        .routes(routes!(crate::openai::models))
        // Status / discovery / actions
        .routes(routes!(crate::routes::actions))
        // Models
        .routes(routes!(crate::models::list))
        .routes(routes!(crate::models::set_active))
        .routes(routes!(crate::models::download))
        .routes(routes!(
            crate::models::download_status,
            crate::models::cancel_download
        ))
        .routes(routes!(crate::models::delete_model))
        // Aux-models (diarization + VAD)
        .routes(routes!(crate::aux_models::list))
        .routes(routes!(crate::aux_models::download))
        .routes(routes!(
            crate::aux_models::download_status,
            crate::aux_models::cancel_download
        ))
        .routes(routes!(crate::aux_models::delete_model))
        // Sessions history
        .routes(routes!(
            crate::history::list_sessions,
            crate::history::create_session
        ))
        .routes(routes!(crate::history::bulk_clear_audio))
        .routes(routes!(crate::history::stream_session_events))
        .routes(routes!(
            crate::history::get_session,
            crate::history::patch_session,
            crate::history::delete_session
        ))
        .routes(routes!(crate::history::append_final))
        .routes(routes!(
            crate::history::upload_session_audio,
            crate::history::stream_session_audio
        ))
        // Meetings history
        .routes(routes!(
            crate::history::list_meetings,
            crate::history::create_meeting
        ))
        .routes(routes!(
            crate::history::get_meeting,
            crate::history::patch_meeting,
            crate::history::delete_meeting
        ))
        .routes(routes!(
            crate::history::upload_meeting_audio,
            crate::history::stream_meeting_audio
        ))
        // AI config
        .routes(routes!(
            crate::ai_config::get_config,
            crate::ai_config::put_config
        ))
        .routes(routes!(crate::ai_config::list_models))
        .routes(routes!(crate::ai_config::test_config))
        // Dictionary config (zh-convert-dictionary)
        .routes(routes!(
            crate::dictionary_config::get_dictionary,
            crate::dictionary_config::put_dictionary
        ))
        // Status / discovery (token-exempt; documented last)
        .routes(routes!(crate::routes::status))
        .routes(routes!(crate::routes::discovery))
}

/// The assembled OpenAPI document — identical to what `GET /openapi.json`
/// serves in a debug build, but available in **all** builds (spec assembly does
/// not depend on the debug-only serving routes). Used by the `--dump-openapi`
/// subcommand to (re)generate the checked-in `docs/openapi.json` for
/// release/self-hosted consumers, and by the golden-file test.
pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    api_router().into_openapi()
}

#[cfg(test)]
mod tests {
    /// The checked-in `whisper-wrap/docs/openapi.json` must equal the spec
    /// assembled from the current router, compared as NORMALIZED JSON (parsed
    /// into `serde_json::Value` and compared structurally, so object member
    /// order and whitespace are insignificant while array element order is
    /// significant). A route or schema change that forgets to regenerate the
    /// artifact fails here — regenerate with
    /// `whisper-wrap-server --dump-openapi docs/openapi.json`.
    #[test]
    fn checked_in_openapi_json_is_in_sync() {
        let fresh: serde_json::Value =
            serde_json::to_value(super::openapi_spec()).expect("serialize assembled spec");
        let committed_raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/openapi.json"
        ));
        let committed: serde_json::Value =
            serde_json::from_str(committed_raw).expect("committed docs/openapi.json is valid JSON");
        assert_eq!(
            committed, fresh,
            "docs/openapi.json is stale — regenerate with \
             `whisper-wrap-server --dump-openapi docs/openapi.json`"
        );
    }
}
