//! `AsrBackend` — the §D2 swappable ASR-runtime trait, mirroring
//! `DiarizationBackend`. Lets a native-streaming runtime (parakeet-rs
//! Nemotron, `asr_parakeet` under the `parakeet` feature) coexist with
//! whisper-rs behind one `Arc<dyn AsrBackend>`. whisper uses the batch
//! methods and the streaming defaults below.

use crate::asr::{AsrError, TranscribeResult};

/// One incremental streaming step: text produced since the previous push.
#[derive(Debug, Clone, Default)]
pub struct StreamStep {
    pub text: String,
    pub is_final: bool,
}

/// A stateful streaming decode session (one per live connection). Implemented
/// by native-streaming backends; whisper does not provide one.
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
