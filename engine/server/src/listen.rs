//! WS /listen — live captioning over ONE uniform session driver
//! (listen-stream-session-unify). A native-streaming backend (parakeet)
//! supplies its own core `StreamSession`; every other backend (whisper)
//! is wrapped in [`WindowedBatchSession`]. Strategy selection happens
//! once, when the session is obtained — the drive loop is shared.
//!
//! Binary pcm_s16le 16 kHz mono frames in; JSON text events out:
//!   {"type":"partial"|"final","text","start_ms","end_ms"}
//!   {"type":"warning","message":"buffer overflow, oldest audio dropped"}
//!   {"type":"error","message":...} then close 1003

use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use serde_json::json;
use tokio::sync::mpsc;
use whisper_wrap_core::stream::{pcm_to_f32, SAMPLE_RATE};
use whisper_wrap_core::vad::VadBackend;
use whisper_wrap_core::{AsrBackend, StreamSession};

use crate::state::AppState;
use crate::windowed_batch::WindowedBatchSession;

const MIN_FRAME_BYTES: usize = 200;
const MAX_FRAME_BYTES: usize = 65_536;
const CLOSE_UNSUPPORTED_DATA: u16 = 1003;

#[utoipa::path(
    get,
    path = "/listen",
    tag = "transcription",
    description = "WebSocket endpoint for live captioning. The client performs a \
        WebSocket upgrade, then streams 16 kHz mono `pcm_s16le` audio as binary \
        frames. The server emits JSON text messages: \
        `{\"type\":\"partial\"|\"final\",\"text\",\"start_ms\",\"end_ms\"}`, \
        `{\"type\":\"warning\",\"message\":...}`, or `{\"type\":\"error\",\"message\":...}` \
        followed by close code 1003. OpenAPI 3.1 cannot model the bidirectional \
        frame protocol, so this entry is descriptive only and declares no request \
        or response body schema.",
    responses(
        (status = 101, description = "Switching Protocols — the connection is upgraded to WebSocket.")
    )
)]
pub async fn listen(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle(socket, state))
}

async fn handle(socket: WebSocket, state: Arc<AppState>) {
    use futures_util::{SinkExt, StreamExt};
    let (mut sink, mut stream) = socket.split();

    // Writer task: session steps and out-of-band warnings are serialized
    // through one channel.
    let (tx, mut rx) = mpsc::channel::<String>(64);
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        sink
    });

    // One-time strategy selection, then the shared drive loop.
    let session = open_session(
        state.engine_handle(),
        || {
            whisper_wrap_core::vad::make_vad(
                state.config.vad_backend.as_deref(),
                &state.config.silero_vad_model,
            )
        },
        state.config.filter_empty_enabled,
        state.config.filter_min_duration_ms,
        &tx,
    );
    let close_reason = run_stream(session, &mut stream, &tx, &|t: &str| {
        state.dictionary.apply(t)
    })
    .await;

    if let Some(reason) = close_reason {
        let _ = tx
            .send(json!({"type": "error", "message": reason}).to_string())
            .await;
    }
    drop(tx);
    // Reclaim the sink to close with the proper code.
    if let Ok(mut sink) = writer.await {
        if close_reason.is_some() {
            let _ = sink
                .send(Message::Close(Some(CloseFrame {
                    code: CLOSE_UNSUPPORTED_DATA,
                    reason: "".into(),
                })))
                .await;
        }
    }
}

/// The ONE place the streaming strategy is chosen: a native-streaming
/// backend's own session, or the windowed-batch emulation wrapping the
/// (possibly not-yet-loaded) batch engine. `make_vad` is lazy so native
/// connections never construct a VAD.
fn open_session(
    engine: Option<Arc<dyn AsrBackend>>,
    make_vad: impl FnOnce() -> Box<dyn VadBackend>,
    filter_empty_enabled: bool,
    filter_min_duration_ms: u64,
    tx: &mpsc::Sender<String>,
) -> Box<dyn StreamSession> {
    let native = engine.as_ref().and_then(|e| e.open_stream());
    native.unwrap_or_else(|| {
        Box::new(WindowedBatchSession::new(
            engine,
            make_vad(),
            filter_empty_enabled,
            filter_min_duration_ms,
            tx.clone(),
        ))
    })
}

// ---------- the uniform session driver ----------

/// Drive a core `StreamSession` over the socket: each binary PCM frame is
/// pushed through the session on a blocking task (model inference, same
/// off-loading as the batch endpoints' `spawn_blocking` transcribes); on a
/// clean end the session tail is flushed via `finish()`.
///
/// Step contract (see the `StreamSession` trait docs): every non-empty
/// partial step carries the CURRENT FULL utterance hypothesis and is
/// forwarded verbatim — no accumulation here; a final step carries the
/// complete utterance text and advances the segment anchor (even when its
/// text is empty, e.g. a filtered-out windowed final). Message JSON:
/// `{"type":"partial"|"final","text","start_ms","end_ms"}` with `start_ms`
/// anchored at the utterance start and `end_ms` advancing with samples.
///
/// Generic over the message stream so the loop is unit-testable without a
/// WebSocket upgrade. Returns the close reason (`Some` → error + close 1003).
async fn run_stream<S, F>(
    session: Box<dyn StreamSession>,
    stream: &mut S,
    tx: &mpsc::Sender<String>,
    // The dictionary apply step (zh-convert-dictionary): partial and final
    // text pass through the SAME transform, so the finalized text never
    // contradicts the caption the user watched (Live caption consistency).
    apply: &F,
) -> Option<&'static str>
where
    S: futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin,
    F: Fn(&str) -> String,
{
    use futures_util::StreamExt;

    // The session moves in and out of spawn_blocking per frame (it is Send,
    // not Sync), so it lives in an Option between pushes.
    let mut session = Some(session);
    let mut total_samples: u64 = 0;
    let mut segment_start_ms: u64 = 0;

    let close_reason = loop {
        match stream.next().await {
            Some(Ok(Message::Binary(pcm))) => {
                if pcm.len() < MIN_FRAME_BYTES || pcm.len() > MAX_FRAME_BYTES {
                    break Some("frame size out of range");
                }
                let samples = pcm_to_f32(&pcm);
                total_samples += samples.len() as u64;
                let end_ms = total_samples * 1000 / SAMPLE_RATE as u64;

                let mut s = session.take().expect("stream session in place");
                let joined = tokio::task::spawn_blocking(move || {
                    let step = s.push(&samples);
                    (s, step)
                })
                .await;
                let (s, step) = match joined {
                    Ok(v) => v,
                    Err(e) => {
                        log::error!("stream push join failed: {e}");
                        break Some("streaming inference failed");
                    }
                };
                session = Some(s);
                match step {
                    Ok(step) => {
                        if step.is_final {
                            if !step.text.is_empty() {
                                let _ = tx
                                    .send(
                                        json!({
                                            "type": "final",
                                            "text": apply(&step.text),
                                            "start_ms": segment_start_ms,
                                            "end_ms": end_ms,
                                        })
                                        .to_string(),
                                    )
                                    .await;
                            }
                            // The utterance ended either way (an empty final
                            // is a dropped/filtered utterance).
                            segment_start_ms = end_ms;
                        } else if !step.text.is_empty() {
                            let _ = tx
                                .send(
                                    json!({
                                        "type": "partial",
                                        "text": apply(&step.text),
                                        "start_ms": segment_start_ms,
                                        "end_ms": end_ms,
                                    })
                                    .to_string(),
                                )
                                .await;
                        }
                    }
                    Err(e) => {
                        log::error!("stream push failed: {e}");
                        break Some("streaming inference failed");
                    }
                }
            }
            Some(Ok(Message::Text(_))) => break Some("binary PCM expected"),
            Some(Ok(Message::Close(_))) | None => {
                log::info!("WS /listen disconnected");
                break None;
            }
            Some(Ok(_)) => continue, // ping/pong handled by axum
            Some(Err(e)) => {
                log::info!("WS /listen receive error: {e}");
                break None;
            }
        }
    };

    // Clean end: flush the session tail and emit it as the final.
    if close_reason.is_none() {
        if let Some(mut s) = session.take() {
            let end_ms = total_samples * 1000 / SAMPLE_RATE as u64;
            match tokio::task::spawn_blocking(move || s.finish()).await {
                Ok(Ok(step)) => {
                    if !step.text.is_empty() {
                        let _ = tx
                            .send(
                                json!({
                                    "type": "final",
                                    "text": apply(&step.text),
                                    "start_ms": segment_start_ms,
                                    "end_ms": end_ms,
                                })
                                .to_string(),
                            )
                            .await;
                    }
                }
                Ok(Err(e)) => log::error!("stream finish failed: {e}"),
                Err(e) => log::error!("stream finish join failed: {e}"),
            }
        }
    }
    close_reason
}

#[cfg(test)]
mod stream_driver_tests {
    //! The uniform drive loop, exercised through the same `open_session` →
    //! `run_stream` composition the handler uses — no WebSocket upgrade, no
    //! model weights. Native backends hand out a scripted session; the
    //! non-native stub proves the SAME driver wraps it in
    //! `WindowedBatchSession`.

    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::Value;
    use whisper_wrap_core::asr::{AsrError, TranscribeResult};
    use whisper_wrap_core::stream::RmsVad;
    use whisper_wrap_core::StreamStep;

    use super::*;

    struct ScriptedSession {
        steps: std::vec::IntoIter<StreamStep>,
        tail: StreamStep,
    }

    impl StreamSession for ScriptedSession {
        fn push(&mut self, _pcm: &[f32]) -> Result<StreamStep, AsrError> {
            Ok(self.steps.next().unwrap_or_default())
        }
        fn finish(&mut self) -> Result<StreamStep, AsrError> {
            Ok(self.tail.clone())
        }
    }

    struct StubNative {
        script: Vec<StreamStep>,
        tail: StreamStep,
        batch_called: Arc<AtomicBool>,
    }

    impl StubNative {
        fn new(script: Vec<StreamStep>, tail: StreamStep) -> (Arc<Self>, Arc<AtomicBool>) {
            let flag = Arc::new(AtomicBool::new(false));
            let stub = Arc::new(StubNative {
                script,
                tail,
                batch_called: Arc::clone(&flag),
            });
            (stub, flag)
        }
    }

    impl AsrBackend for StubNative {
        fn transcribe(
            &self,
            _samples: &[f32],
            _language: &str,
            _prompt: Option<&str>,
            _translate: bool,
        ) -> Result<TranscribeResult, AsrError> {
            self.batch_called.store(true, Ordering::Relaxed);
            Err(AsrError::Inference(
                "batch transcribe must not run on the native path".into(),
            ))
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
            "stub-native"
        }
        fn load_time_ms(&self) -> u128 {
            0
        }
        fn supports_native_stream(&self) -> bool {
            true
        }
        fn open_stream(&self) -> Option<Box<dyn StreamSession>> {
            Some(Box::new(ScriptedSession {
                steps: self.script.clone().into_iter(),
                tail: self.tail.clone(),
            }))
        }
    }

    /// Non-native stub (`open_stream()` → None): `transcribe` flips a flag
    /// and returns a fixed hypothesis, so the test can prove the windowed
    /// emulation ran real batch inference through the uniform driver.
    struct StubBatchOnly {
        called: Arc<AtomicBool>,
    }

    impl AsrBackend for StubBatchOnly {
        fn transcribe(
            &self,
            samples: &[f32],
            language: &str,
            _prompt: Option<&str>,
            _translate: bool,
        ) -> Result<TranscribeResult, AsrError> {
            self.called.store(true, Ordering::Relaxed);
            Ok(TranscribeResult {
                text: "hi there".into(),
                language: language.to_owned(),
                segments: Vec::new(),
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
            "stub-batch-only"
        }
        fn load_time_ms(&self) -> u128 {
            0
        }
        // Defaults: supports_native_stream() = false, open_stream() = None.
    }

    fn partial(text: &str) -> StreamStep {
        StreamStep {
            text: text.to_owned(),
            is_final: false,
        }
    }

    fn final_step(text: &str) -> StreamStep {
        StreamStep {
            text: text.to_owned(),
            is_final: true,
        }
    }

    /// A binary PCM frame of `ms` milliseconds of silence (16 kHz mono s16le).
    fn frame(ms: usize) -> Message {
        Message::Binary(vec![0u8; ms * (SAMPLE_RATE / 1000) * 2].into())
    }

    /// A binary PCM frame of `ms` milliseconds of speech-level audio:
    /// ±8000 i16 square wave, well above the RMS VAD threshold.
    fn speech_frame(ms: usize) -> Message {
        let n = ms * (SAMPLE_RATE / 1000);
        let pcm: Vec<u8> = (0..n)
            .flat_map(|i| {
                let s: i16 = if i % 2 == 0 { 8000 } else { -8000 };
                s.to_le_bytes()
            })
            .collect();
        Message::Binary(pcm.into())
    }

    /// Drive `frames` through the handler's own `open_session` → `run_stream`
    /// composition; collect (close_reason, messages). Identity apply step —
    /// text is forwarded verbatim, as before zh-convert-dictionary.
    async fn drive(
        engine: Arc<dyn AsrBackend>,
        frames: Vec<Message>,
    ) -> (Option<&'static str>, Vec<Value>) {
        drive_with(engine, frames, |t| t.to_owned()).await
    }

    /// Same as [`drive`] but with an explicit dictionary apply step, mirroring
    /// how `handle()` passes `state.dictionary.apply`.
    async fn drive_with(
        engine: Arc<dyn AsrBackend>,
        frames: Vec<Message>,
        apply: impl Fn(&str) -> String,
    ) -> (Option<&'static str>, Vec<Value>) {
        let (tx, mut rx) = mpsc::channel::<String>(64);
        let session = open_session(
            Some(engine),
            || Box::new(RmsVad::default()) as Box<dyn VadBackend>,
            false,
            0,
            &tx,
        );
        let items: Vec<Result<Message, axum::Error>> = frames.into_iter().map(Ok).collect();
        let mut stream = futures_util::stream::iter(items);
        let reason = run_stream(session, &mut stream, &tx, &apply).await;
        drop(tx);
        let mut out = Vec::new();
        while let Some(msg) = rx.recv().await {
            out.push(serde_json::from_str(&msg).expect("json message"));
        }
        (reason, out)
    }

    // Live caption consistency (zh-convert-dictionary): partial and final
    // text pass through the SAME dictionary apply step, so the finalized
    // text never contradicts the caption the user watched.
    #[tokio::test]
    async fn partials_and_finals_pass_through_the_same_apply_step() {
        use crate::dictionary_config::{apply_config, DictionaryConfig};

        let cfg: DictionaryConfig = serde_json::from_value(serde_json::json!({
            "zh_convert": "s2tw",
            "replacements": [ { "from": "雲端", "to": "雲端硬碟" } ]
        }))
        .expect("valid test config");
        let (stub, _) = StubNative::new(vec![partial("简体")], final_step("云端"));
        let frames = vec![frame(250)];
        let (reason, msgs) = drive_with(stub, frames, move |t| apply_config(t, &cfg)).await;

        assert_eq!(reason, None);
        assert_eq!(
            msgs,
            vec![
                // Partial: converted (簡体→簡體) before it reaches the socket.
                serde_json::json!({"type": "partial", "text": "簡體", "start_ms": 0, "end_ms": 250}),
                // Finish tail final: converted, THEN the Traditional-script
                // rule applies (云端 → 雲端 → 雲端硬碟).
                serde_json::json!({"type": "final", "text": "雲端硬碟", "start_ms": 0, "end_ms": 250}),
            ]
        );
    }

    #[tokio::test]
    async fn partials_forward_the_full_hypothesis_verbatim() {
        // The session yields the CURRENT FULL utterance hypothesis per step;
        // the driver forwards it verbatim (no accumulation) and the finish
        // tail carries the whole utterance.
        let (stub, batch_called) = StubNative::new(
            vec![partial("hello "), partial(""), partial("hello world")],
            partial("hello world!"),
        );
        let frames = vec![frame(250), frame(250), frame(250)];
        let (reason, msgs) = drive(stub, frames).await;

        assert_eq!(reason, None);
        assert_eq!(
            msgs,
            vec![
                serde_json::json!({"type": "partial", "text": "hello ", "start_ms": 0, "end_ms": 250}),
                // the empty second step emits nothing
                serde_json::json!({"type": "partial", "text": "hello world", "start_ms": 0, "end_ms": 750}),
                serde_json::json!({"type": "final", "text": "hello world!", "start_ms": 0, "end_ms": 750}),
            ]
        );
        assert!(
            !batch_called.load(Ordering::Relaxed),
            "windowed-batch transcribe must never run on the native path"
        );
    }

    #[tokio::test]
    async fn is_final_step_emits_final_and_advances_the_segment_anchor() {
        let (stub, _) = StubNative::new(
            vec![final_step("你好"), partial("again")],
            // the finish tail is the FULL remaining utterance
            final_step("again"),
        );
        let (reason, msgs) = drive(stub, vec![frame(250), frame(250)]).await;

        assert_eq!(reason, None);
        assert_eq!(
            msgs,
            vec![
                serde_json::json!({"type": "final", "text": "你好", "start_ms": 0, "end_ms": 250}),
                // next utterance anchors at the last final
                serde_json::json!({"type": "partial", "text": "again", "start_ms": 250, "end_ms": 500}),
                // close persists the un-finalized tail utterance
                serde_json::json!({"type": "final", "text": "again", "start_ms": 250, "end_ms": 500}),
            ]
        );
    }

    #[tokio::test]
    async fn empty_final_step_emits_nothing_but_advances_the_anchor() {
        // A dropped/filtered utterance: is_final with empty text sends no
        // message but still ends the segment.
        let (stub, _) = StubNative::new(
            vec![partial("a"), final_step(""), partial("b")],
            partial(""),
        );
        let (reason, msgs) = drive(stub, vec![frame(250), frame(250), frame(250)]).await;

        assert_eq!(reason, None);
        assert_eq!(
            msgs,
            vec![
                serde_json::json!({"type": "partial", "text": "a", "start_ms": 0, "end_ms": 250}),
                serde_json::json!({"type": "partial", "text": "b", "start_ms": 500, "end_ms": 750}),
            ]
        );
    }

    #[tokio::test]
    async fn silence_only_stream_emits_nothing() {
        let (stub, _) = StubNative::new(vec![partial(""), partial("")], partial(""));
        let (reason, msgs) = drive(stub, vec![frame(250), frame(250)]).await;
        assert_eq!(reason, None);
        assert!(msgs.is_empty(), "no text → no messages, got {msgs:?}");
    }

    #[tokio::test]
    async fn out_of_range_frame_closes_with_reason_and_skips_the_tail_flush() {
        let (stub, _) = StubNative::new(vec![partial("hi")], partial("tail"));
        let oversize = Message::Binary(vec![0u8; MAX_FRAME_BYTES + 2].into());
        let (reason, msgs) = drive(stub, vec![frame(250), oversize]).await;
        assert_eq!(reason, Some("frame size out of range"));
        assert_eq!(
            msgs,
            vec![
                serde_json::json!({"type": "partial", "text": "hi", "start_ms": 0, "end_ms": 250})
            ],
            "error close must not flush a final"
        );
    }

    #[tokio::test]
    async fn text_message_closes_with_binary_pcm_expected() {
        let (stub, _) = StubNative::new(vec![], partial("tail"));
        let (reason, msgs) = drive(stub, vec![Message::Text("nope".into())]).await;
        assert_eq!(reason, Some("binary PCM expected"));
        assert!(msgs.is_empty());
    }

    #[tokio::test]
    async fn non_native_backend_is_driven_through_the_windowed_batch_session() {
        // Task 2.1: a backend with `open_stream()` → None goes through the
        // SAME driver, wrapped in `WindowedBatchSession` — its batch
        // `transcribe` runs (flag flips), partials arrive at the windowed
        // cadence, and the silence threshold trips a final.
        let called = Arc::new(AtomicBool::new(false));
        let stub: Arc<dyn AsrBackend> = Arc::new(StubBatchOnly {
            called: Arc::clone(&called),
        });
        let mut frames: Vec<Message> = (0..8).map(|_| speech_frame(250)).collect();
        frames.extend((0..3).map(|_| frame(250)));
        let (reason, msgs) = drive(stub, frames).await;

        assert_eq!(reason, None);
        assert!(
            called.load(Ordering::Relaxed),
            "windowed emulation must run batch transcribe"
        );
        assert_eq!(
            msgs,
            vec![
                // first partial inference at the 500 ms-of-audio boundary
                // past speech onset (750 ms in); repeats of the same fixed
                // hypothesis are consensus-suppressed.
                serde_json::json!({"type": "partial", "text": "hi there", "start_ms": 0, "end_ms": 750}),
                // silence ≥ 700 ms → full-buffer final.
                serde_json::json!({"type": "final", "text": "hi there", "start_ms": 0, "end_ms": 2750}),
            ]
        );
    }
}
