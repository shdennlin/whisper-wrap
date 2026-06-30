//! Pure streaming primitives for `WS /listen`. Port of the
//! non-async parts of `app/services/stream.py`: RMS energy, PCM
//! conversion, and the v2.1 partial-consensus filter (simplified
//! LocalAgreement-2). The async session state machine lives in the
//! server crate; everything here is deterministic and unit-tested.

pub const SAMPLE_RATE: usize = 16_000;
pub const BYTES_PER_SAMPLE: usize = 2;
pub const SILENCE_RMS_THRESHOLD: f32 = 500.0;
pub const SILENCE_DURATION_MS: u64 = 700;
pub const PARTIAL_INTERVAL_MS: u64 = 500;
pub const PARTIAL_WINDOW_MS: u64 = 5000;
pub const MAX_BUFFER_SECONDS: usize = 30;
pub const MAX_BUFFER_BYTES: usize = MAX_BUFFER_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
pub const PARTIAL_WINDOW_BYTES: usize =
    (PARTIAL_WINDOW_MS as usize * SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;

/// Root-mean-square of an int16 little-endian PCM buffer.
pub fn compute_rms(pcm: &[u8]) -> f32 {
    let n = pcm.len() / 2;
    if n == 0 {
        return 0.0;
    }
    let sum_sq: f64 = pcm
        .chunks_exact(2)
        .map(|c| {
            let s = i16::from_le_bytes([c[0], c[1]]) as f64;
            s * s
        })
        .sum();
    ((sum_sq / n as f64) as f32).sqrt()
}

/// Convert int16 LE PCM bytes to f32 samples in [-1, 1].
pub fn pcm_to_f32(pcm: &[u8]) -> Vec<f32> {
    pcm.chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect()
}

/// Duration in ms of a pcm_s16le 16 kHz mono frame.
pub fn frame_duration_ms(pcm: &[u8]) -> u64 {
    let n_samples = pcm.len() / BYTES_PER_SAMPLE;
    (n_samples as u64 * 1000) / SAMPLE_RATE as u64
}

/// Int16 RMS-energy VAD (the v2 `RmsVad`) — the explicit opt-out
/// backend and the auto-fallback when silero is unavailable.
pub struct RmsVad {
    threshold: f32,
}

impl Default for RmsVad {
    fn default() -> Self {
        RmsVad {
            threshold: SILENCE_RMS_THRESHOLD,
        }
    }
}

impl RmsVad {
    pub fn is_speech(&self, pcm: &[u8]) -> bool {
        compute_rms(pcm) >= self.threshold
    }
}

// ---------- Partial-consensus filter ----------

/// ASCII punctuation (Python's `string.punctuation`) + the CJK set
/// from `_PUNCT_CHARS` in stream.py.
const ASCII_PUNCT: &str = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const CJK_PUNCT: &str = "。，！？；：、「」『』（）《》—…";

fn is_word_boundary(ch: char) -> bool {
    if ch.is_whitespace() || ASCII_PUNCT.contains(ch) || CJK_PUNCT.contains(ch) {
        return true;
    }
    let code = ch as u32;
    // CJK Symbols, Hiragana/Katakana, CJK Ext A, CJK Unified,
    // Hangul Syllables, Half/Fullwidth Forms — same ranges as Python.
    matches!(code,
        0x3000..=0x303F
        | 0x3040..=0x30FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xAC00..=0xD7AF
        | 0xFF00..=0xFFEF)
}

/// Longest common prefix of `prev`/`curr`, truncated to end at a word
/// boundary; "" when the useful prefix is shorter than 2 chars.
pub fn compute_lcp_at_word_boundary(prev: &str, curr: &str) -> String {
    if prev.is_empty() || curr.is_empty() {
        return String::new();
    }
    let p: Vec<char> = prev.chars().collect();
    let c: Vec<char> = curr.chars().collect();

    let mut lcp_len = 0;
    for i in 0..p.len().min(c.len()) {
        if p[i] != c[i] {
            break;
        }
        lcp_len = i + 1;
    }
    if lcp_len == 0 {
        return String::new();
    }
    // Clean boundary: LCP consumed all of curr, or the next curr char
    // is itself a boundary.
    if lcp_len == c.len() || is_word_boundary(c[lcp_len]) {
        return p[..lcp_len].iter().collect();
    }
    // Walk backwards for the last boundary inside the LCP.
    let lcp = &p[..lcp_len];
    let last_boundary = (0..lcp_len).rev().find(|&i| is_word_boundary(lcp[i]));
    let Some(b) = last_boundary else {
        return String::new();
    };
    let trimmed: String = lcp[..b].iter().collect();
    if trimmed.trim().chars().count() < 2 {
        return String::new();
    }
    trimmed
}

/// Single-step consensus filter for `partial` events. Caller protocol:
/// call `update()` per sliding-window inference; emit when `Some`;
/// `reset()` at utterance boundaries.
#[derive(Default)]
pub struct PartialConsensusFilter {
    prev: Option<String>,
    last_emitted: Option<String>,
}

impl PartialConsensusFilter {
    pub fn update(&mut self, current: &str) -> Option<String> {
        let prev = self.prev.replace(current.to_owned());
        if current.is_empty() {
            return None;
        }
        match prev {
            None => {
                // First inference: emit verbatim (trailing whitespace
                // trimmed) — "no previous" trivially agrees.
                let text = current.trim_end();
                if text.is_empty() || Some(text) == self.last_emitted.as_deref() {
                    return None;
                }
                self.last_emitted = Some(text.to_owned());
                Some(text.to_owned())
            }
            Some(prev) => {
                let truncated = compute_lcp_at_word_boundary(&prev, current);
                if truncated.is_empty() || Some(truncated.as_str()) == self.last_emitted.as_deref()
                {
                    return None;
                }
                self.last_emitted = Some(truncated.clone());
                Some(truncated)
            }
        }
    }

    pub fn reset(&mut self) {
        self.prev = None;
        self.last_emitted = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rms_of_silence_is_zero() {
        assert_eq!(compute_rms(&[0u8; 1000]), 0.0);
        assert!(!RmsVad::default().is_speech(&[0u8; 1000]));
    }

    #[test]
    fn rms_of_loud_square_wave_is_speech() {
        let mut pcm = Vec::new();
        for _ in 0..800 {
            pcm.extend_from_slice(&8000i16.to_le_bytes());
            pcm.extend_from_slice(&(-8000i16).to_le_bytes());
        }
        assert!(RmsVad::default().is_speech(&pcm));
    }

    #[test]
    fn frame_duration_250ms() {
        // 250 ms @ 16 kHz mono s16le = 8000 bytes
        assert_eq!(frame_duration_ms(&vec![0u8; 8000]), 250);
    }

    #[test]
    fn lcp_clean_boundary_english() {
        // prev/curr agree on "hello world", curr continues at a boundary
        assert_eq!(
            compute_lcp_at_word_boundary("hello world", "hello world again"),
            "hello world"
        );
    }

    #[test]
    fn lcp_mid_word_disagreement_trims_to_boundary() {
        // raw LCP = "hello wor"; ends mid-word → trim back to "hello"
        assert_eq!(
            compute_lcp_at_word_boundary("hello worse", "hello world"),
            "hello"
        );
    }

    #[test]
    fn lcp_cjk_every_char_is_boundary() {
        assert_eq!(
            compute_lcp_at_word_boundary("你好世界嗎", "你好世界喔"),
            "你好世界"
        );
    }

    #[test]
    fn lcp_too_short_is_suppressed() {
        assert_eq!(compute_lcp_at_word_boundary("a b", "a c"), "");
        assert_eq!(compute_lcp_at_word_boundary("xyz", "abc"), "");
    }

    #[test]
    fn consensus_first_inference_emits_verbatim() {
        let mut f = PartialConsensusFilter::default();
        assert_eq!(f.update("你好").as_deref(), Some("你好"));
    }

    #[test]
    fn consensus_suppresses_duplicate_and_disagreement() {
        let mut f = PartialConsensusFilter::default();
        assert_eq!(f.update("你好世").as_deref(), Some("你好世"));
        // Agreeing prefix "你好世" already emitted → suppressed.
        assert_eq!(f.update("你好世界"), None);
        // New agreed prefix grows → emit.
        assert_eq!(f.update("你好世界啊").as_deref(), Some("你好世界"));
        f.reset();
        assert_eq!(f.update("新句子").as_deref(), Some("新句子"));
    }

    #[test]
    fn consensus_empty_inference_suppressed() {
        let mut f = PartialConsensusFilter::default();
        assert_eq!(f.update(""), None);
    }
}
