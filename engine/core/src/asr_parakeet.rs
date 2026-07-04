//! `ParakeetBackend` — Nemotron 3.5 multilingual streaming ASR via
//! parakeet-rs, behind the `parakeet` cargo feature (mirrors how the
//! `diarize` feature gates sherpa-rs). Implements the §D2 `AsrBackend`
//! trait including native streaming (`supports_native_stream`).

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use parakeet_rs::{Nemotron, NemotronMode};

use crate::asr::{AsrError, Segment, TranscribeResult};
use crate::asr_backend::{AsrBackend, StreamSession, StreamStep};

/// Samples per Nemotron streaming chunk: 560 ms @ 16 kHz.
pub const CHUNK_SAMPLES: usize = 8960;

/// Silent flush chunks pushed after the audio so the encoder's lookahead
/// drains and the tail of the utterance is decoded.
const FLUSH_CHUNKS: usize = 3;

/// Pure re-chunker: feed arbitrary-size PCM slices, yields fixed
/// `CHUNK_SAMPLES` blocks. Unit-testable without the model.
#[derive(Debug, Default)]
pub struct ChunkBuffer {
    buf: Vec<f32>,
}

impl ChunkBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Buffer `samples` and return every complete `CHUNK_SAMPLES` block
    /// now available, in order.
    pub fn feed(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.buf.extend_from_slice(samples);
        let n_blocks = self.buf.len() / CHUNK_SAMPLES;
        let mut rest = self.buf.split_off(n_blocks * CHUNK_SAMPLES);
        std::mem::swap(&mut self.buf, &mut rest);
        // `rest` now holds the drained full-block prefix.
        rest.chunks_exact(CHUNK_SAMPLES).map(<[f32]>::to_vec).collect()
    }

    /// Number of samples currently buffered (< `CHUNK_SAMPLES`).
    pub fn remaining(&self) -> usize {
        self.buf.len()
    }

    /// Drain the tail: pad any buffered remainder with zeros to one full
    /// block. `None` when nothing is buffered.
    pub fn take_padded(&mut self) -> Option<Vec<f32>> {
        if self.buf.is_empty() {
            return None;
        }
        let mut block = std::mem::take(&mut self.buf);
        block.resize(CHUNK_SAMPLES, 0.0);
        Some(block)
    }
}

/// Running-utterance accumulator: turns the decoder's per-push text
/// DELTAS into `StreamStep`s that satisfy the trait's driver contract —
/// every non-empty partial carries the CURRENT FULL utterance hypothesis,
/// and `finish` flushes the complete utterance. Pure and unit-testable
/// without the model.
#[derive(Debug, Default)]
struct UtteranceAccumulator {
    utterance: String,
}

impl UtteranceAccumulator {
    /// Fold a push delta in. Empty delta → empty step ("no update");
    /// otherwise the step carries the whole utterance so far.
    fn push_delta(&mut self, delta: &str) -> StreamStep {
        if delta.is_empty() {
            return StreamStep::default();
        }
        self.utterance.push_str(delta);
        StreamStep {
            text: self.utterance.clone(),
            is_final: false,
        }
    }

    /// Fold the flush delta in and consume the utterance as the final.
    fn finish_delta(&mut self, delta: &str) -> StreamStep {
        self.utterance.push_str(delta);
        StreamStep {
            text: std::mem::take(&mut self.utterance),
            is_final: true,
        }
    }
}

/// Nemotron 3.5 streaming ASR backend (parakeet-rs / ONNX Runtime).
///
/// `Nemotron` needs `&mut self` per chunk, so the model sits behind a
/// `Mutex` — one inference at a time, same pattern as `WhisperEngine`'s
/// `Mutex<WhisperContext>`. The `Arc` lets streaming sessions share the
/// model with batch calls.
pub struct ParakeetBackend {
    model: Arc<Mutex<Nemotron>>,
    pub load_time_ms: u128,
}

impl ParakeetBackend {
    /// Load Nemotron from `artifact_dir` (encoder.onnx(+.data),
    /// decoder_joint.onnx, tokenizer.model). Variant is auto-detected.
    pub fn load(artifact_dir: &Path) -> Result<Self, AsrError> {
        let t0 = Instant::now();
        let model =
            Nemotron::from_pretrained(artifact_dir, None).map_err(|e| AsrError::Load(e.to_string()))?;
        Ok(ParakeetBackend {
            model: Arc::new(Mutex::new(model)),
            load_time_ms: t0.elapsed().as_millis(),
        })
    }

    /// Configure the target language on the multilingual variant.
    /// `"auto"` passes through; locale codes (e.g. `"zh-TW"`) pass through.
    /// Unknown codes are logged and left at the previous setting rather
    /// than failing the request. No-op on the English-only variant.
    fn apply_language(model: &mut Nemotron, language: &str) {
        if model.mode() != NemotronMode::Multilingual {
            return;
        }
        if let Err(e) = model.set_target_lang(language) {
            log::warn!("parakeet: set_target_lang({language}) failed, keeping previous: {e}");
        }
    }
}

impl AsrBackend for ParakeetBackend {
    fn transcribe(
        &self,
        samples: &[f32],
        language: &str,
        _prompt: Option<&str>,
        translate: bool,
    ) -> Result<TranscribeResult, AsrError> {
        if translate {
            log::debug!("parakeet: translate=true is unsupported, transcribing instead");
        }
        let mut model = self.model.lock().expect("parakeet model lock");
        model.reset();
        Self::apply_language(&mut model, language);

        let mut chunker = ChunkBuffer::new();
        let mut blocks = chunker.feed(samples);
        if let Some(tail) = chunker.take_padded() {
            blocks.push(tail);
        }
        // Silent flush chunks drain the encoder lookahead.
        blocks.extend(std::iter::repeat_n(vec![0.0f32; CHUNK_SAMPLES], FLUSH_CHUNKS));
        for block in &blocks {
            model
                .transcribe_chunk(block)
                .map_err(|e| AsrError::Inference(e.to_string()))?;
        }
        let text = model.get_transcript().trim().to_owned();
        let duration = samples.len() as f64 / 16_000.0;
        let segments = if text.is_empty() {
            Vec::new()
        } else {
            vec![Segment {
                text: text.clone(),
                start: 0.0,
                end: duration,
                words: None,
            }]
        };
        Ok(TranscribeResult {
            text,
            language: language.to_owned(),
            segments,
            duration_seconds: duration,
        })
    }

    /// Nemotron exposes no word timestamps — words stay `None`.
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
        "parakeet-nemotron"
    }

    fn load_time_ms(&self) -> u128 {
        self.load_time_ms
    }

    fn supports_native_stream(&self) -> bool {
        true
    }

    fn open_stream(&self) -> Option<Box<dyn StreamSession>> {
        // Fresh utterance: clear any state left by a previous session.
        self.model.lock().expect("parakeet model lock").reset();
        Some(Box::new(ParakeetStream {
            model: Arc::clone(&self.model),
            chunker: ChunkBuffer::new(),
            acc: UtteranceAccumulator::default(),
        }))
    }
}

/// One live streaming decode session. Buffers arbitrary-size pushes, runs
/// the model only per full `CHUNK_SAMPLES` block, and accumulates the
/// decoder's deltas so every step carries the full utterance hypothesis
/// (the `StreamSession` driver contract).
struct ParakeetStream {
    model: Arc<Mutex<Nemotron>>,
    chunker: ChunkBuffer,
    acc: UtteranceAccumulator,
}

impl ParakeetStream {
    fn decode_blocks(&mut self, blocks: &[Vec<f32>]) -> Result<String, AsrError> {
        if blocks.is_empty() {
            return Ok(String::new());
        }
        let mut model = self.model.lock().expect("parakeet model lock");
        let mut text = String::new();
        for block in blocks {
            text.push_str(
                &model
                    .transcribe_chunk(block)
                    .map_err(|e| AsrError::Inference(e.to_string()))?,
            );
        }
        Ok(text)
    }
}

impl StreamSession for ParakeetStream {
    fn push(&mut self, pcm_chunk: &[f32]) -> Result<StreamStep, AsrError> {
        let blocks = self.chunker.feed(pcm_chunk);
        let delta = self.decode_blocks(&blocks)?;
        Ok(self.acc.push_delta(&delta))
    }

    fn finish(&mut self) -> Result<StreamStep, AsrError> {
        let mut blocks: Vec<Vec<f32>> = self.chunker.take_padded().into_iter().collect();
        blocks.extend(std::iter::repeat_n(vec![0.0f32; CHUNK_SAMPLES], FLUSH_CHUNKS));
        let delta = self.decode_blocks(&blocks)?;
        Ok(self.acc.finish_delta(&delta))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_buffer_accumulates_across_feeds() {
        let mut cb = ChunkBuffer::new();
        assert!(cb.feed(&vec![0.1f32; 5000]).is_empty());
        assert_eq!(cb.remaining(), 5000);
        let blocks = cb.feed(&vec![0.2f32; 5000]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].len(), CHUNK_SAMPLES);
        // First 5000 samples come from the first feed, the rest from the second.
        assert_eq!(blocks[0][0], 0.1);
        assert_eq!(blocks[0][4999], 0.1);
        assert_eq!(blocks[0][5000], 0.2);
        assert_eq!(cb.remaining(), 10_000 - CHUNK_SAMPLES); // 1040
    }

    #[test]
    fn chunk_buffer_yields_multiple_blocks() {
        let mut cb = ChunkBuffer::new();
        let blocks = cb.feed(&vec![0.5f32; 20_000]);
        assert_eq!(blocks.len(), 2);
        assert!(blocks.iter().all(|b| b.len() == CHUNK_SAMPLES));
        assert_eq!(cb.remaining(), 20_000 - 2 * CHUNK_SAMPLES); // 2080
    }

    #[test]
    fn utterance_accumulator_returns_the_running_full_hypothesis() {
        // Driver contract: partial steps carry the CURRENT FULL utterance
        // hypothesis, not the delta; an empty decode is "no update".
        let mut acc = UtteranceAccumulator::default();
        let step = acc.push_delta("hello ");
        assert!(!step.is_final);
        assert_eq!(step.text, "hello ");
        let step = acc.push_delta("");
        assert!(!step.is_final);
        assert!(step.text.is_empty(), "empty delta must not re-emit");
        let step = acc.push_delta("world");
        assert!(!step.is_final);
        assert_eq!(step.text, "hello world");
    }

    #[test]
    fn utterance_accumulator_finish_flushes_the_whole_utterance() {
        let mut acc = UtteranceAccumulator::default();
        acc.push_delta("hello ");
        acc.push_delta("world");
        let step = acc.finish_delta("!");
        assert!(step.is_final);
        assert_eq!(step.text, "hello world!");
        // The utterance is consumed: a fresh finish yields nothing.
        let step = acc.finish_delta("");
        assert!(step.is_final);
        assert!(step.text.is_empty());
    }

    #[test]
    fn utterance_accumulator_finish_with_no_new_delta_still_returns_the_tail() {
        // A clean close after partials must persist the un-finalized
        // utterance even when the flush decodes nothing new.
        let mut acc = UtteranceAccumulator::default();
        acc.push_delta("again");
        let step = acc.finish_delta("");
        assert!(step.is_final);
        assert_eq!(step.text, "again");
    }

    #[test]
    fn chunk_buffer_take_padded_pads_tail_to_full_block() {
        let mut cb = ChunkBuffer::new();
        cb.feed(&vec![0.3f32; 100]);
        let tail = cb.take_padded().expect("tail block");
        assert_eq!(tail.len(), CHUNK_SAMPLES);
        assert_eq!(tail[99], 0.3);
        assert_eq!(tail[100], 0.0);
        assert_eq!(cb.remaining(), 0);
        assert!(cb.take_padded().is_none());
    }

    /// Real-model batch decode. Needs `NEMOTRON_ONNX_DIR` pointing at a
    /// directory with encoder.onnx(+.data), decoder_joint.onnx and
    /// tokenizer.model. Run with:
    /// `NEMOTRON_ONNX_DIR=... cargo test -p whisper-wrap-core --features parakeet -- --ignored`
    #[test]
    #[ignore = "needs NEMOTRON_ONNX_DIR with real Nemotron weights"]
    fn parakeet_batch_decodes_real_sample() {
        let Ok(dir) = std::env::var("NEMOTRON_ONNX_DIR") else {
            eprintln!("NEMOTRON_ONNX_DIR unset — skipping");
            return;
        };
        let wav_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../samples/real-fleurs-02.wav");
        let samples = read_wav_mono_f32(&wav_path);
        assert!(!samples.is_empty(), "test wav decoded to no samples");

        let backend = ParakeetBackend::load(Path::new(&dir)).expect("load nemotron");
        let out = backend
            .transcribe(&samples, "auto", None, false)
            .expect("transcribe");
        eprintln!("parakeet transcript: {:?}", out.text);
        eprintln!("load_time_ms: {}", backend.load_time_ms());
        assert!(!out.text.is_empty(), "expected non-empty transcript");
        assert_eq!(out.segments.len(), 1);
        assert!(out.duration_seconds > 4.0);
    }

    /// 16 kHz mono 16-bit/float wav → f32 samples (test helper).
    fn read_wav_mono_f32(path: &Path) -> Vec<f32> {
        let mut reader = hound::WavReader::open(path).expect("open wav");
        let spec = reader.spec();
        assert_eq!(spec.sample_rate, 16_000, "test wav must be 16 kHz");
        assert_eq!(spec.channels, 1, "test wav must be mono");
        match spec.sample_format {
            hound::SampleFormat::Float => reader
                .samples::<f32>()
                .map(|s| s.expect("wav sample"))
                .collect(),
            hound::SampleFormat::Int => reader
                .samples::<i16>()
                .map(|s| f32::from(s.expect("wav sample")) / 32768.0)
                .collect(),
        }
    }
}
