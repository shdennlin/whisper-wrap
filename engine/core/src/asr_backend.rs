//! `AsrBackend` — the §D2 swappable ASR-runtime trait, mirroring
//! `DiarizationBackend`. Lets a native-streaming runtime (parakeet-rs
//! Nemotron, `asr_parakeet` under the `parakeet` feature) coexist with
//! whisper-rs behind one `Arc<dyn AsrBackend>`. whisper uses the batch
//! methods and the streaming defaults below.

use crate::asr::{AsrError, TranscribeResult};

/// One streaming step. `text` is NOT a delta: a non-final step carries the
/// CURRENT FULL utterance hypothesis (empty = no update this push); a final
/// step (`is_final`) carries the COMPLETE utterance text and ends it (empty
/// final = the utterance ended with nothing to emit, e.g. filtered noise).
#[derive(Debug, Clone, Default)]
pub struct StreamStep {
    pub text: String,
    pub is_final: bool,
}

/// A stateful streaming decode session (one per live connection).
///
/// # Driver contract (`WS /listen`)
///
/// The driver forwards step text VERBATIM — it never accumulates or diffs.
/// Sessions must therefore return, per `push`, the full current-utterance
/// hypothesis (revisions REPLACE the client's partial line), or empty text
/// when there is nothing new. A step with `is_final` ends the utterance:
/// its text is the whole utterance, and the next non-empty step starts a
/// new one. `finish` flushes any decoder tail and returns the remaining
/// utterance as the final (empty = nothing left to emit; a windowed-batch
/// emulation discards its un-endpointed buffer here).
///
/// `push`/`finish` are synchronous and may run inference inline; the driver
/// off-loads each call onto a blocking task.
///
/// Provided by native-streaming backends via [`AsrBackend::open_stream`];
/// batch-only backends (whisper) are wrapped in the server's
/// `WindowedBatchSession` adapter instead.
pub trait StreamSession: Send {
    fn push(&mut self, pcm_chunk: &[f32]) -> Result<StreamStep, AsrError>;
    fn finish(&mut self) -> Result<StreamStep, AsrError>;
}

/// The ASR runtime behind the active model. Mirrors `DiarizationBackend`.
pub trait AsrBackend: Send + Sync {
    fn transcribe(
        &self,
        samples: &[f32],
        language: &str,
        prompt: Option<&str>,
        translate: bool,
    ) -> Result<TranscribeResult, AsrError>;
    fn transcribe_with_words(
        &self,
        samples: &[f32],
        language: &str,
        prompt: Option<&str>,
        translate: bool,
    ) -> Result<TranscribeResult, AsrError>;
    fn name(&self) -> &'static str;
    fn load_time_ms(&self) -> u128;
    /// True only for native cache-aware streaming backends.
    fn supports_native_stream(&self) -> bool {
        false
    }
    /// Open a streaming session; `None` unless `supports_native_stream()`.
    fn open_stream(&self) -> Option<Box<dyn StreamSession>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asr::{Segment, WhisperEngine};

    /// A weightless stand-in that exercises the trait's object safety and the
    /// streaming defaults without loading a real model.
    struct StubBackend;

    impl AsrBackend for StubBackend {
        fn transcribe(
            &self,
            samples: &[f32],
            language: &str,
            _prompt: Option<&str>,
            _translate: bool,
        ) -> Result<TranscribeResult, AsrError> {
            Ok(TranscribeResult {
                text: String::new(),
                language: language.to_owned(),
                segments: Vec::<Segment>::new(),
                duration_seconds: samples.len() as f64 / 16000.0,
            })
        }
        fn transcribe_with_words(
            &self,
            samples: &[f32],
            language: &str,
            prompt: Option<&str>,
            translate: bool,
        ) -> Result<TranscribeResult, AsrError> {
            self.transcribe(samples, language, prompt, translate)
        }
        fn name(&self) -> &'static str {
            "stub"
        }
        fn load_time_ms(&self) -> u128 {
            0
        }
    }

    /// Compile-level proof that `WhisperEngine` implements `AsrBackend` and is
    /// object-safe as `&dyn AsrBackend` (needs no model weights).
    fn _assert_whisper_is_backend(e: &WhisperEngine) -> &dyn AsrBackend {
        e
    }

    #[test]
    fn dyn_backend_streaming_defaults() {
        let backend: &dyn AsrBackend = &StubBackend;
        assert_eq!(backend.name(), "stub");
        assert!(!backend.supports_native_stream());
        assert!(backend.open_stream().is_none());
        let silence = vec![0.0f32; 16_000];
        let out = backend
            .transcribe(&silence, "auto", None, false)
            .expect("stub transcribe");
        assert_eq!(out.duration_seconds, 1.0);
    }
}
