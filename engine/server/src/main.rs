//! whisper-wrap-server — standalone binary for self-host users.
//! beta.1 surface: POST /transcribe, GET /status, GET /, GET /app/*.

use std::sync::Arc;

use anyhow::Context;
use whisper_wrap_core::{actions, registry, Config, WhisperEngine};
use whisper_wrap_server::ai_config::AiConfigStore;
use whisper_wrap_server::history::HistoryDb;
use whisper_wrap_server::{build_router, AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let config = Config::from_env();
    config.ensure_temp_dir().context("create temp dir")?;

    // Lenient resolve so self-host also boots with zero weights — the model
    // can be fetched via POST /models/download and loaded with POST
    // /models/active, no restart required.
    let model = registry::resolve_active_model_lenient(&config).context("resolve model")?;
    let engine = if model.bin_path.is_file() {
        log::info!(
            "loading model {:?} from {}",
            model.name,
            model.bin_path.display()
        );
        let engine = WhisperEngine::load(&model.bin_path).context("load whisper model")?;
        log::info!("model loaded in {} ms", engine.load_time_ms);
        Some(engine)
    } else {
        log::warn!(
            "no model weights at {} — start one with POST /models/download then /models/active",
            model.bin_path.display()
        );
        None
    };

    // The store owns the persisted config; build the initial client through it
    // so a stored data/llm_config.json takes effect at boot (overrides env).
    let ai_config = AiConfigStore::new(config.clone());
    let llm = ai_config.build_client();
    let (action_list, action_categories) =
        actions::load_actions(&config.actions_path).context("actions registry")?;
    log::info!("loaded {} prompt actions", action_list.len());

    let frontend_dir = std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "app/static/app".into());
    let addr = format!("{}:{}", config.api_host, config.api_port);
    let history = HistoryDb::open(&config.data_dir).context("open history db")?;
    let state = Arc::new(AppState::new(
        config,
        model,
        engine,
        llm,
        ai_config,
        action_list,
        action_categories,
        history,
    ));
    let app = build_router(state, Some(&frontend_dir));

    log::info!("listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("bind {addr} (port in use? set API_PORT)"))?;
    axum::serve(listener, app).await?;
    Ok(())
}
