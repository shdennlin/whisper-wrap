//! whisper-wrap-core — the embedded transcription engine.
//!
//! One crate, three deployment targets (server / desktop / cli).
//! Port of the v2.x Python engine; endpoint contracts are preserved
//! (see whisper-wrap CLAUDE.md "API Endpoints").

pub mod actions;
pub mod asr;
pub mod asr_backend;
#[cfg(feature = "parakeet")]
pub mod asr_parakeet;
pub mod audio;
pub mod config;
pub mod diarize;
pub mod mime;
pub mod postprocess;
pub mod registry;
pub mod replace;
pub mod stream;
pub mod subtitle;
pub mod vad;
pub mod words;
pub mod zh_convert;

pub use asr::{Segment, TranscribeResult, WhisperEngine};
pub use asr_backend::{AsrBackend, StreamSession, StreamStep};
#[cfg(feature = "parakeet")]
pub use asr_parakeet::ParakeetBackend;
pub use config::Config;
pub use registry::ResolvedModel;
