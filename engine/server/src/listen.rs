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

    let mut session = StreamSession::new(state, tx.clone());

    let close_reason: Option<&str> = loop {
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

    if let Some(reason) = close_reason {
        let _ = tx
            .send(json!({"type": "error", "message": reason}).to_string())
            .await;
    }
    drop(tx);
    session.abort_in_flight();
    drop(session); // releases its tx clone so the writer loop can end
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
