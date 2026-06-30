//! whisper-wrap-core — the embedded transcription engine.
//!
//! One crate, three deployment targets (server / desktop / cli).
//! Port of the v2.x Python engine; endpoint contracts are preserved
//! (see whisper-wrap CLAUDE.md "API Endpoints").

pub mod actions;
pub mod asr;
pub mod audio;
pub mod config;
pub mod diarize;
pub mod mime;
pub mod postprocess;
pub mod registry;
pub mod stream;
pub mod subtitle;
pub mod vad;
pub mod words;

pub use asr::{Segment, TranscribeResult, WhisperEngine};
pub use config::Config;
pub use registry::ResolvedModel;
