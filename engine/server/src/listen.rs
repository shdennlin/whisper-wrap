//! WS /listen — live captioning. Port of `app/api/listen.py` +
//! the async `StreamSession` state machine from
//! `app/services/stream.py` (the pure parts live in core::stream).
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
use tokio::sync::{mpsc, Mutex};
use whisper_wrap_core::stream::{
    frame_duration_ms, pcm_to_f32, PartialConsensusFilter, MAX_BUFFER_BYTES, PARTIAL_INTERVAL_MS,
    PARTIAL_WINDOW_BYTES, PARTIAL_WINDOW_MS, SAMPLE_RATE, SILENCE_DURATION_MS,
};

use whisper_wrap_core::AsrBackend;

use crate::state::AppState;

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

    // Writer task: events from the session (including fire-and-forget
    // partial inferences) are serialized through one channel.
    let (tx, mut rx) = mpsc::channel::<String>(64);
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        sink
    });

    // One-time dispatch: a native-streaming backend (parakeet) drives its own
    // session loop; everything else keeps the windowed-batch machine below.
    // Unifying the two paths is the parked listen-stream-session-unify change.
    let native_engine = state
        .engine_handle()
        .filter(|e| e.supports_native_stream());

    let close_reason: Option<&str> = if let Some(engine) = native_engine {
        run_native_stream(engine, &mut stream, &tx).await
    } else {
        let mut session = StreamSession::new(state, tx.clone());
        let reason = loop {
            match stream.next().await {
                Some(Ok(Message::Binary(pcm))) => {
                    if pcm.len() < MIN_FRAME_BYTES || pcm.len() > MAX_FRAME_BYTES {
                        break Some("frame size out of range");
                    }
                    session.feed_frame(&pcm).await;
                }
                Some(Ok(Message::Text(_))) => break Some("binary PCM expected"),
                Some(Ok(Message::Close(_))) | None => {
                    log::info!("WS /listen disconnected (in-flight buffer discarded)");
                    break None;
                }
                Some(Ok(_)) => continue, // ping/pong handled by axum
                Some(Err(e)) => {
                    log::info!("WS /listen receive error: {e} (buffer discarded)");
                    break None;
                }
            }
        };
        session.abort_in_flight();
        // session drops here, releasing its tx clone so the writer loop can end
        reason
    };

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

// ---------- native streaming path (parakeet) ----------

/// Drive a native-streaming backend's `StreamSession` over the socket:
/// each binary PCM frame is pushed through the session on a blocking task
/// (ONNX inference, same off-loading as the batch path's `spawn_blocking`
/// transcribes); on a clean end the decoder tail is flushed via `finish()`.
///
/// The session yields DELTA text per push; deltas accumulate into the
/// current utterance so `partial` messages carry the running utterance text
/// (the client replaces its partial line) and `final` messages carry the
/// whole utterance (the client stores finals verbatim). Message JSON is
/// byte-compatible with the windowed-batch machine:
/// `{"type":"partial"|"final","text","start_ms","end_ms"}`.
///
/// Generic over the message stream so the loop is unit-testable without a
/// WebSocket upgrade. Returns the close reason (`Some` → error + close 1003),
/// mirroring the windowed-batch loop.
async fn run_native_stream<S>(
    engine: Arc<dyn AsrBackend>,
    stream: &mut S,
    tx: &mpsc::Sender<String>,
) -> Option<&'static str>
where
    S: futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    use futures_util::StreamExt;

    let Some(session) = engine.open_stream() else {
        // supports_native_stream() promised a session; surface the broken
        // promise as a socket error rather than panicking the WS task.
        log::error!("native-stream backend returned no session");
        return Some("native streaming session unavailable");
    };
    // The session moves in and out of spawn_blocking per frame (it is Send,
    // not Sync), so it lives in an Option between pushes.
    let mut session = Some(session);
    let mut total_samples: u64 = 0;
    let mut utterance = String::new();
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
                        log::error!("native stream push join failed: {e}");
                        break Some("streaming inference failed");
                    }
                };
                session = Some(s);
                match step {
                    Ok(step) => {
                        if !step.text.is_empty() {
                            utterance.push_str(&step.text);
                        }
                        if step.is_final && !utterance.is_empty() {
                            let _ = tx
                                .send(
                                    json!({
                                        "type": "final",
                                        "text": utterance,
                                        "start_ms": segment_start_ms,
                                        "end_ms": end_ms,
                                    })
                                    .to_string(),
                                )
                                .await;
                            utterance.clear();
                            segment_start_ms = end_ms;
                        } else if !step.text.is_empty() {
                            let _ = tx
                                .send(
                                    json!({
                                        "type": "partial",
                                        "text": utterance,
                                        "start_ms": segment_start_ms,
                                        "end_ms": end_ms,
                                    })
                                    .to_string(),
                                )
                                .await;
                        }
                    }
                    Err(e) => {
                        log::error!("native stream push failed: {e}");
                        break Some("streaming inference failed");
                    }
                }
            }
            Some(Ok(Message::Text(_))) => break Some("binary PCM expected"),
            Some(Ok(Message::Close(_))) | None => {
                log::info!("WS /listen disconnected (native stream)");
                break None;
            }
            Some(Ok(_)) => continue, // ping/pong handled by axum
            Some(Err(e)) => {
                log::info!("WS /listen receive error: {e} (native stream)");
                break None;
            }
        }
    };

    // Clean end: flush the decoder tail and emit the utterance as the final.
    if close_reason.is_none() {
        if let Some(mut s) = session.take() {
            let end_ms = total_samples * 1000 / SAMPLE_RATE as u64;
            match tokio::task::spawn_blocking(move || s.finish()).await {
                Ok(Ok(step)) => {
                    utterance.push_str(&step.text);
                    if !utterance.is_empty() {
                        let _ = tx
                            .send(
                                json!({
                                    "type": "final",
                                    "text": utterance,
                                    "start_ms": segment_start_ms,
                                    "end_ms": end_ms,
                                })
                                .to_string(),
                            )
                            .await;
                    }
                }
                Ok(Err(e)) => log::error!("native stream finish failed: {e}"),
                Err(e) => log::error!("native stream finish join failed: {e}"),
            }
        }
    }
    close_reason
}

// ---------- session state machine ----------

struct StreamSession {
    state: Arc<AppState>,
    tx: mpsc::Sender<String>,
    vad: Box<dyn whisper_wrap_core::vad::VadBackend>,
    consensus: Arc<Mutex<PartialConsensusFilter>>,
    audio_ms: u64,
    buffer: Vec<u8>,
    utterance_start_ms: u64,
    last_partial_ms: u64,
    last_voice_ms: u64,
    last_partial_voice_ms: i64, // -1 = first partial fires unconditionally
    speech_onset_ms: u64,
    in_utterance: bool,
    overflow_warned: bool,
    partial_in_flight: Option<tokio::task::JoinHandle<()>>,
}

impl StreamSession {
    fn new(state: Arc<AppState>, tx: mpsc::Sender<String>) -> Self {
        let vad = whisper_wrap_core::vad::make_vad(
            state.config.vad_backend.as_deref(),
            &state.config.silero_vad_model,
        );
        StreamSession {
            state,
            tx,
            vad,
            consensus: Arc::new(Mutex::new(PartialConsensusFilter::default())),
            audio_ms: 0,
            buffer: Vec::new(),
            utterance_start_ms: 0,
            last_partial_ms: 0,
            last_voice_ms: 0,
            last_partial_voice_ms: -1,
            speech_onset_ms: 0,
            in_utterance: false,
            overflow_warned: false,
            partial_in_flight: None,
        }
    }

    fn abort_in_flight(&mut self) {
        if let Some(h) = self.partial_in_flight.take() {
            h.abort();
        }
    }

    async fn feed_frame(&mut self, pcm: &[u8]) {
        // Backpressure: cap at 30 s; warn once per overflow event.
        if self.buffer.len() + pcm.len() > MAX_BUFFER_BYTES {
            let overflow = self.buffer.len() + pcm.len() - MAX_BUFFER_BYTES;
            self.buffer.drain(..overflow);
            if !self.overflow_warned {
                let _ = self
                    .tx
                    .send(
                        json!({"type": "warning", "message": "buffer overflow, oldest audio dropped"})
                            .to_string(),
                    )
                    .await;
                self.overflow_warned = true;
            }
        }

        self.buffer.extend_from_slice(pcm);
        self.audio_ms += frame_duration_ms(pcm);
        let now_ms = self.audio_ms;

        if self.vad.is_speech(pcm) {
            self.last_voice_ms = now_ms;
            if !self.in_utterance {
                // New utterance: discard pre-roll silence, anchor here.
                self.in_utterance = true;
                self.utterance_start_ms = now_ms;
                self.speech_onset_ms = now_ms - frame_duration_ms(pcm);
                self.last_partial_ms = now_ms;
                self.buffer = pcm.to_vec();
                self.overflow_warned = false;
            }
        }

        if !self.in_utterance {
            // Keep last 1 s of silence to anchor a possible start.
            let tail = 2 * SAMPLE_RATE;
            if self.buffer.len() > tail {
                let cut = self.buffer.len() - tail;
                self.buffer.drain(..cut);
            }
            return;
        }

        let final_due = now_ms - self.last_voice_ms >= SILENCE_DURATION_MS;
        let partial_due = now_ms - self.last_partial_ms >= PARTIAL_INTERVAL_MS;

        // Final supersedes partial on the same frame.
        if partial_due && !final_due {
            let no_new_speech = self.last_partial_voice_ms != -1
                && (self.last_voice_ms as i64) <= self.last_partial_voice_ms;
            let in_flight = self
                .partial_in_flight
                .as_ref()
                .is_some_and(|h| !h.is_finished());
            if no_new_speech {
                // Nothing new for whisper — skip and wait a fresh interval.
                self.last_partial_ms = now_ms;
            } else if !in_flight {
                self.last_partial_ms = now_ms;
                self.last_partial_voice_ms = self.last_voice_ms as i64;
                self.spawn_partial(now_ms);
            }
            // else: inference still running — drop this cadence fire.
        }

        if final_due {
            // Preserve partial→final ordering.
            if let Some(h) = self.partial_in_flight.take() {
                let _ = h.await;
            }
            self.emit_final(now_ms).await;
            self.in_utterance = false;
            self.buffer.clear();
            self.consensus.lock().await.reset();
            self.last_partial_voice_ms = -1;
        }
    }

    fn spawn_partial(&mut self, end_ms: u64) {
        if self.buffer.is_empty() {
            return;
        }
        // Tail window bounds partial inference cost.
        let (tail, window_start_ms) = if self.buffer.len() > PARTIAL_WINDOW_BYTES {
            (
                self.buffer[self.buffer.len() - PARTIAL_WINDOW_BYTES..].to_vec(),
                self.utterance_start_ms
                    .max(end_ms.saturating_sub(PARTIAL_WINDOW_MS)),
            )
        } else {
            (self.buffer.clone(), self.utterance_start_ms)
        };

        // No model loaded (fresh install) — skip inference. The PWA's
        // first-run gate keeps clients off /listen until one is loaded.
        let Some(engine) = self.state.engine_handle() else {
            return;
        };
        let consensus = Arc::clone(&self.consensus);
        let tx = self.tx.clone();
        self.partial_in_flight = Some(tokio::spawn(async move {
            let samples = pcm_to_f32(&tail);
            let text = match tokio::task::spawn_blocking(move || {
                engine.transcribe(&samples, "auto", None, false)
            })
            .await
            {
                Ok(Ok(r)) => r.text,
                Ok(Err(e)) => return log::error!("Partial transcription failed: {e}"),
                Err(e) => return log::error!("Partial task join failed: {e}"),
            };
            let Some(filtered) = consensus.lock().await.update(&text) else {
                return;
            };
            let _ = tx
                .send(
                    json!({
                        "type": "partial",
                        "text": filtered,
                        "start_ms": window_start_ms,
                        "end_ms": end_ms,
                    })
                    .to_string(),
                )
                .await;
        }));
    }

    async fn emit_final(&mut self, end_ms: u64) {
        if self.buffer.is_empty() {
            return;
        }
        let samples = pcm_to_f32(&self.buffer);
        let Some(engine) = self.state.engine_handle() else {
            return;
        };
        let text = match tokio::task::spawn_blocking(move || {
            engine.transcribe(&samples, "auto", None, false)
        })
        .await
        {
            Ok(Ok(r)) => r.text,
            Ok(Err(e)) => return log::error!("Final transcription failed: {e}"),
            Err(e) => return log::error!("Final task join failed: {e}"),
        };

        let speech_duration_ms = self.last_voice_ms.saturating_sub(self.speech_onset_ms);
        use whisper_wrap_core::postprocess::{filter_empty_transcription, FilterDecision};
        match filter_empty_transcription(
            &text,
            Some(speech_duration_ms as f64),
            self.state.config.filter_empty_enabled,
            self.state.config.filter_min_duration_ms,
        ) {
            FilterDecision::Drop(reason) => {
                log::info!(
                    "transcription_filtered endpoint=/listen reason={} duration_ms={speech_duration_ms} raw_text_len={}",
                    reason.as_str(),
                    text.len()
                );
            }
            FilterDecision::Keep(text) => {
                let _ = self
                    .tx
                    .send(
                        json!({
                            "type": "final",
                            "text": text,
                            "start_ms": self.utterance_start_ms,
                            "end_ms": end_ms,
                        })
                        .to_string(),
                    )
                    .await;
            }
        }
    }
}

#[cfg(test)]
mod native_stream_tests {
    //! Task 7.4: the native-stream loop, driven with a scripted
    //! `StreamSession` — no WebSocket upgrade, no model weights. The stub
    //! backend's batch `transcribe` errors AND flips a flag, so any
    //! accidental fall-through to the windowed-batch inference would fail
    //! the message assertions and the flag check.

    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::Value;
    use whisper_wrap_core::asr::{AsrError, TranscribeResult};
    use whisper_wrap_core::{StreamSession as CoreStreamSession, StreamStep};

    use super::*;

    struct ScriptedSession {
        steps: std::vec::IntoIter<StreamStep>,
        tail: StreamStep,
    }

    impl CoreStreamSession for ScriptedSession {
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
        fn open_stream(&self) -> Option<Box<dyn CoreStreamSession>> {
            Some(Box::new(ScriptedSession {
                steps: self.script.clone().into_iter(),
                tail: self.tail.clone(),
            }))
        }
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

    /// A binary PCM frame of `ms` milliseconds (16 kHz mono s16le).
    fn frame(ms: usize) -> Message {
        Message::Binary(vec![0u8; ms * (SAMPLE_RATE / 1000) * 2].into())
    }

    /// Run the native loop over `frames`; collect (close_reason, messages).
    async fn drive(
        engine: Arc<dyn AsrBackend>,
        frames: Vec<Message>,
    ) -> (Option<&'static str>, Vec<Value>) {
        let (tx, mut rx) = mpsc::channel::<String>(64);
        let items: Vec<Result<Message, axum::Error>> = frames.into_iter().map(Ok).collect();
        let mut stream = futures_util::stream::iter(items);
        let reason = run_native_stream(engine, &mut stream, &tx).await;
        drop(tx);
        let mut out = Vec::new();
        while let Some(msg) = rx.recv().await {
            out.push(serde_json::from_str(&msg).expect("json message"));
        }
        (reason, out)
    }

    #[tokio::test]
    async fn partials_accumulate_deltas_and_close_flushes_the_final() {
        let (stub, batch_called) = StubNative::new(
            vec![partial("hello "), partial(""), partial("world")],
            partial("!"),
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
            partial(""),
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
            vec![serde_json::json!({"type": "partial", "text": "hi", "start_ms": 0, "end_ms": 250})],
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
}
