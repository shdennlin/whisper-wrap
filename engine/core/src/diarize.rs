//! Speaker diarization — the §5 `DiarizationBackend` swappable trait.
//! First implementation: sherpa-onnx (pyannote segmentation 3.0 +
//! CAM++ zh embedding) behind the `diarize` cargo feature. Future
//! tiers (WavLM, community pyannote-ONNX, Python sidecar) implement
//! the same trait without architectural change.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SpeakerSegment {
    pub start: f64,
    pub end: f64,
    pub speaker: String,
}

pub trait DiarizationBackend: Send + Sync {
    fn diarize(
        &self,
        samples: &[f32],
        num_speakers: Option<usize>,
    ) -> anyhow::Result<Vec<SpeakerSegment>>;
    fn name(&self) -> &'static str;
}

/// Assign a speaker to each ASR segment by midpoint containment in the
/// diarization timeline (nearest segment when no interval contains it).
/// Pure + unit-tested; mirrors the v2 WhisperX assign_word_speakers
/// behaviour at segment granularity.
pub fn assign_speakers(
    asr: &[crate::asr::Segment],
    diar: &[SpeakerSegment],
) -> Vec<MeetingSegment> {
    asr.iter()
        .map(|seg| {
            let mid = (seg.start + seg.end) / 2.0;
            let speaker = diar
                .iter()
                .find(|d| d.start <= mid && mid <= d.end)
                .map(|d| d.speaker.clone())
                .or_else(|| {
                    diar.iter()
                        .min_by(|a, b| {
                            let da = (mid - a.start).abs().min((mid - a.end).abs());
                            let db = (mid - b.start).abs().min((mid - b.end).abs());
                            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                        })
                        .map(|d| d.speaker.clone())
                })
                .unwrap_or_else(|| "SPEAKER_00".to_owned());
            MeetingSegment {
                speaker,
                start: seg.start,
                end: seg.end,
                text: seg.text.clone(),
                // Words inherit the segment's speaker — consistent
                // with diarizing at segment granularity.
                words: seg.words.clone(),
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct MeetingSegment {
    pub speaker: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<crate::words::Word>>,
}

#[cfg(feature = "diarize")]
pub use sherpa_impl::SherpaCamPP;

#[cfg(feature = "diarize")]
mod sherpa_impl {
    use std::path::Path;
    use std::sync::Mutex;

    use sherpa_rs::diarize::{Diarize, DiarizeConfig};

    use super::{DiarizationBackend, SpeakerSegment};

    /// sherpa-onnx pyannote-segmentation + CAM++ zh — the "Fast" tier.
    pub struct SherpaCamPP {
        // sherpa's Diarize is not Sync; serialize access (matches the
        // single-job meeting pipeline anyway).
        inner: Mutex<Diarize>,
    }

    impl SherpaCamPP {
        pub fn new(seg_model: &Path, emb_model: &Path) -> anyhow::Result<Self> {
            let config = DiarizeConfig {
                ..Default::default()
            };
            let diarize = Diarize::new(
                seg_model.to_str().unwrap_or_default(),
                emb_model.to_str().unwrap_or_default(),
                config,
            )
            .map_err(|e| anyhow::anyhow!("diarizer init failed: {e:?}"))?;
            Ok(SherpaCamPP {
                inner: Mutex::new(diarize),
            })
        }
    }

    impl DiarizationBackend for SherpaCamPP {
        fn diarize(
            &self,
            samples: &[f32],
            num_speakers: Option<usize>,
        ) -> anyhow::Result<Vec<SpeakerSegment>> {
            // sherpa clusters with a fixed config per Diarize instance;
            // num_speakers hint requires a rebuild — accepted for the
            // Fast tier (auto-clustering), hint logged and ignored.
            if let Some(n) = num_speakers {
                log::info!("diarize: num_speakers hint {n} noted (auto-clustering in Fast tier)");
            }
            let segments = self
                .inner
                .lock()
                .expect("diarizer lock")
                .compute(samples.to_vec(), None)
                .map_err(|e| anyhow::anyhow!("diarize failed: {e:?}"))?;
            Ok(segments
                .into_iter()
                .map(|s| SpeakerSegment {
                    start: s.start as f64,
                    end: s.end as f64,
                    speaker: format!("SPEAKER_{:02}", s.speaker),
                })
                .collect())
        }

        fn name(&self) -> &'static str {
            "sherpa-campp"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asr::Segment;

    fn seg(start: f64, end: f64, text: &str) -> Segment {
        Segment {
            start,
            end,
            text: text.into(),
            words: None,
        }
    }

    fn spk(start: f64, end: f64, speaker: &str) -> SpeakerSegment {
        SpeakerSegment {
            start,
            end,
            speaker: speaker.into(),
        }
    }

    #[test]
    fn midpoint_containment_assigns_speaker() {
        let asr = vec![seg(0.0, 2.0, "hi"), seg(2.5, 4.0, "there")];
        let diar = vec![spk(0.0, 2.2, "SPEAKER_00"), spk(2.3, 5.0, "SPEAKER_01")];
        let merged = assign_speakers(&asr, &diar);
        assert_eq!(merged[0].speaker, "SPEAKER_00");
        assert_eq!(merged[1].speaker, "SPEAKER_01");
    }

    #[test]
    fn gap_falls_back_to_nearest() {
        // ASR segment sits in a diarization gap → nearest wins.
        let asr = vec![seg(5.0, 6.0, "gap")];
        let diar = vec![spk(0.0, 2.0, "SPEAKER_00"), spk(6.2, 9.0, "SPEAKER_01")];
        let merged = assign_speakers(&asr, &diar);
        assert_eq!(merged[0].speaker, "SPEAKER_01");
    }

    #[test]
    fn empty_diarization_defaults_speaker_00() {
        let merged = assign_speakers(&[seg(0.0, 1.0, "x")], &[]);
        assert_eq!(merged[0].speaker, "SPEAKER_00");
    }
}
