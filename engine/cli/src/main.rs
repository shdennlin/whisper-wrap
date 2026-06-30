//! whisper-wrap-cli — scriptable transcription.
//! Usage: whisper-wrap-cli transcribe <file> [--language <code>] [--prompt <text>] [--json]

use anyhow::{bail, Context, Result};
use whisper_wrap_core::{audio, registry, Config, WhisperEngine};

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();

    match args.first().map(String::as_str) {
        Some("transcribe") => transcribe(&args[1..]),
        _ => bail!("usage: whisper-wrap-cli transcribe <file> [--language <code>] [--prompt <text>] [--json]"),
    }
}

fn transcribe(args: &[String]) -> Result<()> {
    let mut file = None;
    let mut language = "auto".to_owned();
    let mut prompt = None;
    let mut as_json = false;

    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--language" => language = it.next().context("--language needs a value")?.clone(),
            "--prompt" => prompt = Some(it.next().context("--prompt needs a value")?.clone()),
            "--json" => as_json = true,
            other if file.is_none() => file = Some(other.to_owned()),
            other => bail!("unexpected argument: {other}"),
        }
    }
    let file = file.context("missing <file>")?;

    let config = Config::from_env();
    let model = registry::resolve_active_model(&config)?;
    eprintln!("model: {} ({})", model.name, model.bin_path.display());
    let engine = WhisperEngine::load(&model.bin_path)?;

    let samples =
        audio::decode_to_samples(std::path::Path::new(&file), config.upload_timeout_seconds)?;
    let result = engine.transcribe(&samples, &language, prompt.as_deref(), false)?;

    if as_json {
        println!(
            "{}",
            serde_json::json!({
                "text": result.text,
                "language": result.language,
                "segments": result.segments,
            })
        );
    } else {
        println!("{}", result.text);
    }
    Ok(())
}
