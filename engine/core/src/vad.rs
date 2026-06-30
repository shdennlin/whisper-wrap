//! Pluggable per-frame VAD — port of `app/services/vad.py`.
//! Selection policy (matches v2): `VAD_BACKEND=rms` or `=silero`
//! opts in explicitly; unset tries silero first and falls back to
//! RMS with one INFO line.

use std::path::Path;

use crate::stream::RmsVad;

pub trait VadBackend: Send {
    fn is_speech(&mut self, pcm: &[u8]) -> bool;
    fn name(&self) -> &'static str;
}

impl VadBackend for RmsVad {
    fn is_speech(&mut self, pcm: &[u8]) -> bool {
        RmsVad::is_speech(self, pcm)
    }
    fn name(&self) -> &'static str {
        "rms"
    }
}

/// Build a fresh VAD instance for one streaming session (the v2
/// `vad_factory` pattern — silero is stateful per session).
pub fn make_vad(backend: Option<&str>, silero_model: &Path) -> Box<dyn VadBackend> {
    match backend {
        Some("rms") => Box::new(RmsVad::default()),
        Some("silero") => match silero::SileroFrameVad::new(silero_model) {
            Ok(v) => Box::new(v),
            Err(e) => {
                log::warn!(
                    "VAD_BACKEND=silero requested but init failed ({e}); falling back to rms"
                );
                Box::new(RmsVad::default())
            }
        },
        _ => match silero::SileroFrameVad::new(silero_model) {
            Ok(v) => Box::new(v),
            Err(e) => {
                log::info!("silero VAD unavailable ({e}); using rms fallback");
                Box::new(RmsVad::default())
            }
        },
    }
}

#[cfg(feature = "diarize")]
mod silero {
    use std::path::Path;

    use sherpa_rs::silero_vad::{SileroVad, SileroVadConfig};

    use super::VadBackend;
    use crate::stream::pcm_to_f32;

    pub struct SileroFrameVad {
        inner: SileroVad,
    }

    impl SileroFrameVad {
        pub fn new(model: &Path) -> anyhow::Result<Self> {
            if !model.is_file() {
                anyhow::bail!("silero model not found at {}", model.display());
            }
            let config = SileroVadConfig {
                model: model.to_string_lossy().into_owned(),
                // Frame-level detection: we only consume `is_speech()`,
                // the segment-assembly knobs stay near defaults.
                min_silence_duration: 0.25,
                min_speech_duration: 0.1,
                max_speech_duration: 30.0,
                ..Default::default()
            };
            let inner = SileroVad::new(config, 60.0)
                .map_err(|e| anyhow::anyhow!("silero init failed: {e:?}"))?;
            Ok(SileroFrameVad { inner })
        }
    }

    impl VadBackend for SileroFrameVad {
        fn is_speech(&mut self, pcm: &[u8]) -> bool {
            self.inner.accept_waveform(pcm_to_f32(pcm));
            self.inner.is_speech()
        }
        fn name(&self) -> &'static str {
            "silero"
        }
    }
}

#[cfg(not(feature = "diarize"))]
mod silero {
    use std::path::Path;

    use super::VadBackend;

    /// Stub when built without sherpa — `new` always errors, so the
    /// factory falls back to RMS.
    pub struct SileroFrameVad;
    impl SileroFrameVad {
        pub fn new(_model: &Path) -> anyhow::Result<Self> {
            anyhow::bail!("built without the `diarize` feature")
        }
    }
    impl VadBackend for SileroFrameVad {
        fn is_speech(&mut self, _pcm: &[u8]) -> bool {
            false
        }
        fn name(&self) -> &'static str {
            "silero-stub"
        }
    }
}
