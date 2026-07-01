//! WhisperEngine — the v3 counterpart of the v2 `WhisperBackend`
//! Protocol, backed by whisper-rs (whisper.cpp, Metal on macOS).
//! Response shape matches `PyWhisperCppBackend.transcribe`.

use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use thiserror::Error;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::words::{tokens_to_words, RawToken, Word};

#[derive(Debug, Error)]
pub enum AsrError {
    #[error("model load failed: {0}")]
    Load(String),
    #[error("inference failed: {0}")]
    Inference(String),
}

// `Deserialize` so a persisted transcript snapshot can be re-read to merge
// with a later diarization (stage-run-endpoints diarize stage).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Segment {
    pub text: String,
    pub start: f64,
    pub end: f64,
    // Set by the meeting pipeline and the item transcribe stage; None on the
    // /transcribe, /listen and OpenAI-compat paths, where it is skipped in JSON
    // so those outputs stay byte-stable.
    // `default` so a snapshot serialized without `words` round-trips.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub words: Option<Vec<Word>>,
}

#[derive(Debug, Clone)]
pub struct TranscribeResult {
    pub text: String,
    pub language: String,
    pub segments: Vec<Segment>,
    pub duration_seconds: f64,
}

pub struct WhisperEngine {
    // whisper-rs states are not Sync; one inference at a time matches
    // the v2 "single in-process model, requests queue" behavior.
    ctx: Mutex<WhisperContext>,
    pub load_time_ms: u128,
}

impl WhisperEngine {
    pub fn load(model_path: &Path) -> Result<Self, AsrError> {
        let t0 = Instant::now();
        let ctx = WhisperContext::new_with_params(
            model_path
                .to_str()
                .ok_or_else(|| AsrError::Load("non-utf8 model path".into()))?,
            WhisperContextParameters::default(),
        )
        .map_err(|e| AsrError::Load(e.to_string()))?;
        let engine = WhisperEngine {
            ctx: Mutex::new(ctx),
            load_time_ms: t0.elapsed().as_millis(),
        };
        engine.warmup();
        Ok(engine)
    }

    /// Best-effort warmup: run one inference on a short silent buffer so
    /// the first *real* request doesn't eat the ~13s Metal pipeline /
    /// shader compile. Failures are logged and swallowed — a warmup
    /// problem must never block startup.
    fn warmup(&self) {
        let t = Instant::now();
        // 1s of silence @ 16 kHz — enough to trigger the full graph.
        let silence = vec![0.0f32; 16_000];
        match self.transcribe(&silence, "auto", None, false) {
            Ok(_) => log::info!("engine warmup complete in {} ms", t.elapsed().as_millis()),
            Err(e) => log::warn!("engine warmup failed (non-fatal): {e}"),
        }
    }

    /// Transcribe 16 kHz mono f32 samples.
    /// `language`: "auto" or a whisper language code. `translate`:
    /// whisper's translate task (output always English).
    pub fn transcribe(
        &self,
        samples: &[f32],
        language: &str,
        prompt: Option<&str>,
        translate: bool,
    ) -> Result<TranscribeResult, AsrError> {
        self.transcribe_impl(samples, language, prompt, translate, false)
    }

    /// Like `transcribe`, but also fills `Segment::words` from
    /// whisper.cpp's heuristic token timestamps (the meeting-mode
    /// word-level path; v2 used wav2vec2 forced alignment for this).
    pub fn transcribe_with_words(
        &self,
        samples: &[f32],
        language: &str,
        prompt: Option<&str>,
        translate: bool,
    ) -> Result<TranscribeResult, AsrError> {
        self.transcribe_impl(samples, language, prompt, translate, true)
    }

    fn transcribe_impl(
        &self,
        samples: &[f32],
        language: &str,
        prompt: Option<&str>,
        translate: bool,
        word_timestamps: bool,
    ) -> Result<TranscribeResult, AsrError> {
        let ctx = self.ctx.lock().expect("whisper ctx poisoned");
        let mut state = ctx
            .create_state()
            .map_err(|e| AsrError::Inference(e.to_string()))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language));
        params.set_translate(translate);
        if let Some(p) = prompt {
            params.set_initial_prompt(p);
        }
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_token_timestamps(word_timestamps);

        state
            .full(params, samples)
            .map_err(|e| AsrError::Inference(e.to_string()))?;

        // Special tokens ([_BEG_], language tags, timestamps...) all
        // have ids >= EOT; real text tokens sit below it.
        let token_eot = ctx.token_eot();
        let mut segments = Vec::new();
        let mut text = String::new();
        for i in 0..state.full_n_segments() {
            let Some(seg) = state.get_segment(i) else {
                break;
            };
            let seg_text = seg
                .to_str_lossy()
                .map_err(|e| AsrError::Inference(e.to_string()))?
                .trim()
                .to_owned();
            text.push_str(&seg_text);
            let words = if word_timestamps {
                let mut tokens = Vec::new();
                for t in 0..seg.n_tokens() {
                    let Some(tok) = seg.get_token(t) else { break };
                    if tok.token_id() >= token_eot {
                        continue;
                    }
                    let Ok(bytes) = tok.to_bytes() else { continue };
                    let data = tok.token_data();
                    tokens.push(RawToken {
                        bytes: bytes.to_vec(),
                        t0: data.t0,
                        t1: data.t1,
                    });
                }
                Some(tokens_to_words(&tokens))
            } else {
                None
            };
            segments.push(Segment {
                text: seg_text,
                start: seg.start_timestamp() as f64 / 100.0,
                end: seg.end_timestamp() as f64 / 100.0,
                words,
            });
        }

        let lang_id = state.full_lang_id_from_state();
        let language = whisper_rs::get_lang_str(lang_id)
            .unwrap_or("und")
            .to_owned();

        Ok(TranscribeResult {
            text,
            language,
            duration_seconds: samples.len() as f64 / 16000.0,
            segments,
        })
    }
}
