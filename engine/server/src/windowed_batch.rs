//! `WindowedBatchSession` — the whisper "windowed-batch" live-caption
//! emulation, packaged as a core [`StreamSession`] so `WS /listen` can
//! drive every backend through one uniform loop (listen-stream-session-unify).
//!
//! This is the former inline `listen.rs` state machine: VAD endpointing,
//! a ~500 ms-of-audio partial cadence over a sliding tail window, a final
//! on the silence threshold, and the LocalAgreement partial-consensus
//! filter. All pure primitives (constants, RMS/VAD, consensus) come from
//! `whisper_wrap_core::stream` — nothing is duplicated here.

use std::sync::Arc;

use serde_json::json;
use tokio::sync::mpsc;
use whisper_wrap_core::postprocess::{filter_empty_transcription, FilterDecision};
use whisper_wrap_core::stream::{
    BYTES_PER_SAMPLE, MAX_BUFFER_BYTES, PARTIAL_INTERVAL_MS, PARTIAL_WINDOW_BYTES, SAMPLE_RATE,
    SILENCE_DURATION_MS,
};
use whisper_wrap_core::stream::PartialConsensusFilter;
use whisper_wrap_core::vad::VadBackend;
use whisper_wrap_core::{AsrBackend, StreamSession, StreamStep};
use whisper_wrap_core::asr::AsrError;

/// Sample-count versions of the byte-based core constants (the session
/// buffers `f32` samples; the driver already decoded the wire PCM).
const MAX_BUFFER_SAMPLES: usize = MAX_BUFFER_BYTES / BYTES_PER_SAMPLE;
const PARTIAL_WINDOW_SAMPLES: usize = PARTIAL_WINDOW_BYTES / BYTES_PER_SAMPLE;
/// Pre-roll silence kept while idle so a new utterance can anchor:
/// 1 s (the legacy machine's `2 * SAMPLE_RATE` BYTES).
const SILENCE_TAIL_SAMPLES: usize = SAMPLE_RATE;

/// Duration in ms of `n` samples at 16 kHz.
fn samples_ms(n: usize) -> u64 {
    n as u64 * 1000 / SAMPLE_RATE as u64
}

/// Inverse of `pcm_to_f32` — the per-frame VAD consumes `pcm_s16le`
/// bytes; exact for samples that originated as i16 PCM.
fn f32_to_pcm(samples: &[f32]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|s| (((s * 32768.0).clamp(-32768.0, 32767.0)) as i16).to_le_bytes())
        .collect()
}

/// Windowed-batch emulation of a streaming session over a batch-only
/// backend (whisper). Owns VAD endpointing, the audio-time partial
/// cadence ([`PARTIAL_INTERVAL_MS`]), sliding-window `transcribe` calls
/// filtered through [`PartialConsensusFilter`], and the silence-trip
/// final ([`SILENCE_DURATION_MS`]) with the empty-transcription filter.
///
/// # Concurrency model (deliberate change from the legacy inline machine)
///
/// The legacy `listen.rs` machine spawned partial inferences on a
/// cancellable task (skip the cadence tick while one is in flight, await
/// it before a final). `StreamSession::push` is synchronous, so inference
/// now runs INLINE inside the driver's per-push `spawn_blocking`.
/// Consequence: on slow models a silence-triggered final waits for the
/// in-flight partial to complete instead of aborting it — a bounded
/// latency increase, accepted to get one uniform `/listen` driver (the
/// native-streaming path has the same property).
///
/// # Engine binding
///
/// `engine` is bound once at session open. `None` reproduces the
/// fresh-install behavior (no model loaded): VAD and buffering run, but
/// no inference happens and no text is ever produced. Inference errors
/// are logged and swallowed (empty step), matching the legacy machine —
/// a failed partial/final never tears down the socket.
pub struct WindowedBatchSession {
    engine: Option<Arc<dyn AsrBackend>>,
    vad: Box<dyn VadBackend>,
    consensus: PartialConsensusFilter,
    filter_empty_enabled: bool,
    filter_min_duration_ms: u64,
    /// Out-of-band channel for `{"type":"warning",...}` frames (buffer
    /// overflow) — the `StreamStep` contract has no warning slot.
    warn_tx: mpsc::Sender<String>,
    audio_ms: u64,
    buffer: Vec<f32>,
    last_partial_ms: u64,
    last_voice_ms: u64,
    last_partial_voice_ms: i64, // -1 = first partial fires unconditionally
    speech_onset_ms: u64,
    in_utterance: bool,
    overflow_warned: bool,
}

impl WindowedBatchSession {
    pub fn new(
        engine: Option<Arc<dyn AsrBackend>>,
        vad: Box<dyn VadBackend>,
        filter_empty_enabled: bool,
        filter_min_duration_ms: u64,
        warn_tx: mpsc::Sender<String>,
    ) -> Self {
        WindowedBatchSession {
            engine,
            vad,
            consensus: PartialConsensusFilter::default(),
            filter_empty_enabled,
            filter_min_duration_ms,
            warn_tx,
            audio_ms: 0,
            buffer: Vec::new(),
            last_partial_ms: 0,
            last_voice_ms: 0,
            last_partial_voice_ms: -1,
            speech_onset_ms: 0,
            in_utterance: false,
            overflow_warned: false,
        }
    }

    /// Sliding-window partial inference through the consensus filter.
    /// `None` = nothing to emit this tick (no engine, inference failure,
    /// or the consensus filter suppressed the hypothesis).
    fn partial_hypothesis(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            return None;
        }
        // No model loaded (fresh install) — skip inference. The PWA's
        // first-run gate keeps clients off /listen until one is loaded.
        let engine = self.engine.as_ref()?;
        // Tail window bounds partial inference cost.
        let window = if self.buffer.len() > PARTIAL_WINDOW_SAMPLES {
            &self.buffer[self.buffer.len() - PARTIAL_WINDOW_SAMPLES..]
        } else {
            &self.buffer[..]
        };
        let text = match engine.transcribe(window, "auto", None, false) {
            Ok(r) => r.text,
            Err(e) => {
                log::error!("Partial transcription failed: {e}");
                return None;
            }
        };
        self.consensus.update(&text)
    }

    /// Full-buffer final inference + empty-transcription filter.
    /// Empty string = nothing to emit (the utterance still ends).
    fn finalize_utterance(&mut self) -> String {
        if self.buffer.is_empty() {
            return String::new();
        }
        let Some(engine) = self.engine.as_ref() else {
            return String::new();
        };
        let text = match engine.transcribe(&self.buffer, "auto", None, false) {
            Ok(r) => r.text,
            Err(e) => {
                log::error!("Final transcription failed: {e}");
                return String::new();
            }
        };
        let speech_duration_ms = self.last_voice_ms.saturating_sub(self.speech_onset_ms);
        match filter_empty_transcription(
            &text,
            Some(speech_duration_ms as f64),
            self.filter_empty_enabled,
            self.filter_min_duration_ms,
        ) {
            FilterDecision::Drop(reason) => {
                log::info!(
                    "transcription_filtered endpoint=/listen reason={} duration_ms={speech_duration_ms} raw_text_len={}",
                    reason.as_str(),
                    text.len()
                );
                String::new()
            }
            FilterDecision::Keep(text) => text,
        }
    }
}

impl StreamSession for WindowedBatchSession {
    fn push(&mut self, pcm_chunk: &[f32]) -> Result<StreamStep, AsrError> {
        // Backpressure: cap at 30 s; warn once per overflow event.
        if self.buffer.len() + pcm_chunk.len() > MAX_BUFFER_SAMPLES {
            let overflow = self.buffer.len() + pcm_chunk.len() - MAX_BUFFER_SAMPLES;
            self.buffer.drain(..overflow);
            if !self.overflow_warned {
                let _ = self.warn_tx.try_send(
                    json!({"type": "warning", "message": "buffer overflow, oldest audio dropped"})
                        .to_string(),
                );
                self.overflow_warned = true;
            }
        }

        self.buffer.extend_from_slice(pcm_chunk);
        let frame_ms = samples_ms(pcm_chunk.len());
        self.audio_ms += frame_ms;
        let now_ms = self.audio_ms;

        if self.vad.is_speech(&f32_to_pcm(pcm_chunk)) {
            self.last_voice_ms = now_ms;
            if !self.in_utterance {
                // New utterance: discard pre-roll silence, anchor here.
                self.in_utterance = true;
                self.speech_onset_ms = now_ms - frame_ms;
                self.last_partial_ms = now_ms;
                self.buffer = pcm_chunk.to_vec();
                self.overflow_warned = false;
            }
        }

        if !self.in_utterance {
            // Keep last 1 s of silence to anchor a possible start.
            if self.buffer.len() > SILENCE_TAIL_SAMPLES {
                let cut = self.buffer.len() - SILENCE_TAIL_SAMPLES;
                self.buffer.drain(..cut);
            }
            return Ok(StreamStep::default());
        }

        let final_due = now_ms - self.last_voice_ms >= SILENCE_DURATION_MS;
        let partial_due = now_ms - self.last_partial_ms >= PARTIAL_INTERVAL_MS;

        // Final supersedes partial on the same frame.
        if partial_due && !final_due {
            let no_new_speech = self.last_partial_voice_ms != -1
                && (self.last_voice_ms as i64) <= self.last_partial_voice_ms;
            if no_new_speech {
                // Nothing new for whisper — skip and wait a fresh interval.
                self.last_partial_ms = now_ms;
            } else {
                self.last_partial_ms = now_ms;
                self.last_partial_voice_ms = self.last_voice_ms as i64;
                if let Some(text) = self.partial_hypothesis() {
                    return Ok(StreamStep {
                        text,
                        is_final: false,
                    });
                }
            }
        }

        if final_due {
            let text = self.finalize_utterance();
            self.in_utterance = false;
            self.buffer.clear();
            self.consensus.reset();
            self.last_partial_voice_ms = -1;
            return Ok(StreamStep {
                text,
                is_final: true,
            });
        }

        Ok(StreamStep::default())
    }

    fn finish(&mut self) -> Result<StreamStep, AsrError> {
        // Parity with the legacy machine: a socket close mid-utterance
        // discards the un-endpointed buffer — finals only ever come from
        // the silence trip. The empty final ends the utterance without
        // emitting anything.
        self.buffer.clear();
        self.in_utterance = false;
        Ok(StreamStep {
            text: String::new(),
            is_final: true,
        })
    }
}

#[cfg(test)]
mod parity_tests {
    //! Task 1.1 parity test: drive `WindowedBatchSession` DIRECTLY (no
    //! WebSocket) over a stub `AsrBackend` and assert the pre-refactor
    //! cadence/shape: partials at the ~500 ms-of-audio boundary (as the
    //! consensus filter permits), one `is_final` step once the silence
    //! threshold trips.

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use tokio::sync::mpsc;
    use whisper_wrap_core::asr::{AsrError, Segment, TranscribeResult};
    use whisper_wrap_core::stream::RmsVad;
    use whisper_wrap_core::{AsrBackend, StreamSession, StreamStep};

    use super::WindowedBatchSession;

    /// Non-native stub: `transcribe` returns the scripted hypothesis for
    /// call N (sticking at the last entry) and records the sample count
    /// of every inference so the test can assert window/full-buffer sizes.
    struct StubBatch {
        script: Vec<&'static str>,
        calls: AtomicUsize,
        call_sample_lens: Mutex<Vec<usize>>,
    }

    impl StubBatch {
        fn new(script: Vec<&'static str>) -> Arc<Self> {
            Arc::new(StubBatch {
                script,
                calls: AtomicUsize::new(0),
                call_sample_lens: Mutex::new(Vec::new()),
            })
        }
    }

    impl AsrBackend for StubBatch {
        fn transcribe(
            &self,
            samples: &[f32],
            language: &str,
            _prompt: Option<&str>,
            _translate: bool,
        ) -> Result<TranscribeResult, AsrError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            self.call_sample_lens
                .lock()
                .expect("lens lock")
                .push(samples.len());
            let text = *self.script.get(n).or(self.script.last()).unwrap_or(&"");
            Ok(TranscribeResult {
                text: text.to_owned(),
                language: language.to_owned(),
                segments: Vec::<Segment>::new(),
                duration_seconds: samples.len() as f64 / 16_000.0,
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
            "stub-batch"
        }
        fn load_time_ms(&self) -> u128 {
            0
        }
        // supports_native_stream()/open_stream() keep the trait defaults:
        // false / None — this backend goes through the windowed emulation.
    }

    /// 250 ms of speech-level samples: ±0.25 square wave — same idiom as
    /// core stream.rs's `rms_of_loud_square_wave_is_speech` (i16 8192,
    /// far above `SILENCE_RMS_THRESHOLD`).
    fn speech_frame() -> Vec<f32> {
        (0..4000)
            .map(|i| if i % 2 == 0 { 0.25 } else { -0.25 })
            .collect()
    }

    /// 250 ms of digital silence.
    fn silence_frame() -> Vec<f32> {
        vec![0.0f32; 4000]
    }

    fn session(
        engine: Option<Arc<dyn AsrBackend>>,
        filter_enabled: bool,
        filter_min_ms: u64,
    ) -> (WindowedBatchSession, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel::<String>(8);
        (
            WindowedBatchSession::new(engine, Box::new(RmsVad::default()), filter_enabled, filter_min_ms, tx),
            rx,
        )
    }

    fn assert_quiet(step: &StreamStep) {
        assert!(!step.is_final, "unexpected final: {step:?}");
        assert!(step.text.is_empty(), "unexpected text: {step:?}");
    }

    fn assert_partial(step: &StreamStep, text: &str) {
        assert!(!step.is_final, "expected partial, got final: {step:?}");
        assert_eq!(step.text, text);
    }

    #[test]
    fn speech_then_silence_yields_cadenced_partials_then_a_final() {
        // 8×250 ms speech then 3×250 ms silence. Audio-time trace (identical
        // to the pre-refactor inline machine):
        //   750 ms  first partial inference   → consensus emits "hello"
        //  1250 ms  second inference          → agreed prefix already emitted
        //  1750 ms  third inference           → emits "hello world"
        //  2250 ms  fourth (speech since last partial) → "hello world again"
        //  2750 ms  silence ≥ 700 ms          → full-buffer final
        let stub = StubBatch::new(vec![
            "hello",
            "hello world",
            "hello world again",
            "hello world again more",
            "final text",
        ]);
        let (mut s, _rx) = session(Some(stub.clone()), false, 0);

        let mut steps = Vec::new();
        for _ in 0..8 {
            steps.push(s.push(&speech_frame()).expect("push"));
        }
        for _ in 0..3 {
            steps.push(s.push(&silence_frame()).expect("push"));
        }

        assert_partial(&steps[2], "hello");
        assert_partial(&steps[6], "hello world");
        assert_partial(&steps[8], "hello world again");
        assert!(steps[10].is_final, "silence threshold must trip a final");
        assert_eq!(steps[10].text, "final text");
        for i in [0, 1, 3, 4, 5, 7, 9] {
            assert_quiet(&steps[i]);
        }

        // Cadence proof: 4 windowed partial inferences + 1 full-buffer final.
        assert_eq!(stub.calls.load(Ordering::SeqCst), 5);
        let lens = stub.call_sample_lens.lock().expect("lens lock");
        // Final inference sees the whole utterance buffer: 11 frames of
        // 4000 samples anchored at speech onset.
        assert_eq!(*lens.last().expect("final call"), 11 * 4000);
    }

    #[test]
    fn silence_only_never_infers_or_finalizes() {
        let stub = StubBatch::new(vec!["never"]);
        let (mut s, _rx) = session(Some(stub.clone()), false, 0);
        for _ in 0..8 {
            let step = s.push(&silence_frame()).expect("push");
            assert_quiet(&step);
        }
        assert_eq!(stub.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn dropped_final_is_an_empty_is_final_step() {
        // Empty-transcription filter enabled with a huge min duration:
        // the utterance still ENDS (is_final:true) but carries no text,
        // so the driver emits nothing — parity with the old emit_final
        // Drop branch.
        let stub = StubBatch::new(vec!["you"]);
        let (mut s, _rx) = session(Some(stub), true, 60_000);
        for _ in 0..3 {
            s.push(&speech_frame()).expect("push");
        }
        let mut final_step = None;
        for _ in 0..3 {
            let step = s.push(&silence_frame()).expect("push");
            if step.is_final {
                final_step = Some(step);
                break;
            }
        }
        let step = final_step.expect("silence threshold must trip a final");
        assert!(step.text.is_empty(), "filtered final must carry no text");
    }

    #[test]
    fn finish_discards_the_unendpointed_buffer() {
        // Parity: the legacy machine never emitted a final on socket close —
        // the in-flight buffer was discarded.
        let stub = StubBatch::new(vec!["never"]);
        let (mut s, _rx) = session(Some(stub.clone()), false, 0);
        s.push(&speech_frame()).expect("push");
        s.push(&speech_frame()).expect("push");
        let step = s.finish().expect("finish");
        assert!(step.is_final);
        assert!(step.text.is_empty(), "close must not flush a final");
        assert_eq!(stub.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn no_engine_loaded_consumes_audio_and_emits_no_text() {
        // Fresh-install parity: with no model loaded the legacy machine ran
        // VAD but skipped inference entirely.
        let (mut s, _rx) = session(None, false, 0);
        for _ in 0..8 {
            let step = s.push(&speech_frame()).expect("push");
            assert!(step.text.is_empty());
        }
        for _ in 0..3 {
            let step = s.push(&silence_frame()).expect("push");
            assert!(step.text.is_empty());
        }
    }

    #[test]
    fn buffer_overflow_warns_once_and_drops_oldest_audio() {
        let stub = StubBatch::new(vec!["hi"]);
        let (mut s, mut rx) = session(Some(stub), false, 0);
        // 2 s speech-level frames; 17 pushes = 34 s > the 30 s cap.
        let big: Vec<f32> = (0..32_000)
            .map(|i| if i % 2 == 0 { 0.25 } else { -0.25 })
            .collect();
        for _ in 0..17 {
            let _ = s.push(&big).expect("push");
        }
        let warning = rx.try_recv().expect("one overflow warning");
        assert_eq!(
            warning,
            serde_json::json!({"type": "warning", "message": "buffer overflow, oldest audio dropped"})
                .to_string()
        );
        assert!(rx.try_recv().is_err(), "warning must fire once per overflow event");
    }
}
