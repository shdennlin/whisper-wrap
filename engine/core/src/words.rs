//! Token → word aggregation for word-level timestamps (meeting mode).
//!
//! whisper.cpp emits sub-word tokens with heuristic per-token times
//! (`token_data().t0/t1`, centiseconds) when `token_timestamps` is on.
//! This module folds those tokens into display words: leading-space
//! tokens open a new word (English sub-words merge), CJK ideographs
//! each become their own word (matches how zh reads and makes
//! click-to-seek per-character precise), punctuation sticks to the
//! word before it. Pure functions — unit-testable without a model.

use serde::{Deserialize, Serialize};

/// One time-aligned word. Field names mirror the v2 WhisperX shape the
/// PWA meeting view declares (`frontend/src/meeting/types.ts::Word`).
/// `Deserialize` so a persisted transcript snapshot can be re-read for the
/// diarize-merge stage (stage-run-endpoints).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Word {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

/// A non-special whisper token as extracted from a segment: raw bytes
/// (whisper splits CJK across UTF-8 boundaries, so text may be a
/// partial code point) plus heuristic times in centiseconds.
pub struct RawToken {
    pub bytes: Vec<u8>,
    pub t0: i64,
    pub t1: i64,
}

/// Ideograph/kana/hangul — characters that act as standalone words.
/// Deliberately EXCLUDES the CJK punctuation blocks (0x3000-303F,
/// 0xFF00-FFEF): like ASCII punctuation, "。" should attach to the
/// word before it, not stand alone.
fn is_cjk_word_char(ch: char) -> bool {
    matches!(ch as u32,
        0x3040..=0x30FF      // Hiragana + Katakana
        | 0x3400..=0x4DBF    // CJK Ext A
        | 0x4E00..=0x9FFF    // CJK Unified
        | 0xAC00..=0xD7AF) // Hangul Syllables
}

struct WordBuilder {
    words: Vec<Word>,
    text: String,
    start: f64,
    end: f64,
    // Current word is a single CJK char: trailing punctuation still
    // attaches, but the next letter/ideograph starts a fresh word.
    cjk: bool,
}

impl WordBuilder {
    fn flush(&mut self) {
        self.cjk = false;
        if !self.text.is_empty() {
            self.words.push(Word {
                word: std::mem::take(&mut self.text),
                start: self.start,
                end: self.end,
            });
        }
    }

    /// Consume one decoded piece spanning [t0, t1] seconds. Tokens are
    /// short, so every char in a piece shares the piece's times.
    fn push_piece(&mut self, s: &str, t0: f64, t1: f64) {
        for ch in s.chars() {
            if ch.is_whitespace() {
                self.flush();
            } else if is_cjk_word_char(ch) {
                self.flush();
                self.text.push(ch);
                self.start = t0;
                self.end = t1;
                self.cjk = true;
            } else {
                if self.cjk && ch.is_alphanumeric() {
                    self.flush();
                }
                if self.text.is_empty() {
                    self.start = t0;
                }
                self.text.push(ch);
                self.end = t1;
            }
        }
    }
}

/// Fold a segment's tokens into words. Tokens whose bytes end mid
/// code point are buffered until the next token completes them (the
/// buffered span keeps the first token's t0 and the last token's t1).
pub fn tokens_to_words(tokens: &[RawToken]) -> Vec<Word> {
    let mut out = WordBuilder {
        words: Vec::new(),
        text: String::new(),
        start: 0.0,
        end: 0.0,
        cjk: false,
    };
    let mut pending: Vec<u8> = Vec::new();
    let mut pending_t0: i64 = 0;

    for tok in tokens {
        if pending.is_empty() {
            pending_t0 = tok.t0;
        }
        pending.extend_from_slice(&tok.bytes);
        if let Ok(s) = std::str::from_utf8(&pending) {
            let piece = s.to_owned();
            out.push_piece(&piece, pending_t0 as f64 / 100.0, tok.t1 as f64 / 100.0);
            pending.clear();
        }
        // else: partial UTF-8 — keep buffering into the next token.
    }
    // Trailing bytes that never completed a code point are dropped:
    // they cannot render as text, and a U+FFFD would only add noise.
    out.flush();
    out.words
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(s: &str, t0: i64, t1: i64) -> RawToken {
        RawToken {
            bytes: s.as_bytes().to_vec(),
            t0,
            t1,
        }
    }

    #[test]
    fn english_subwords_merge_on_leading_space() {
        // " hel" + "lo" + " world" → ["hello", "world"]
        let words =
            tokens_to_words(&[tok(" hel", 0, 20), tok("lo", 20, 40), tok(" world", 50, 90)]);
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].word, "hello");
        assert_eq!(words[0].start, 0.0);
        assert_eq!(words[0].end, 0.4);
        assert_eq!(words[1].word, "world");
        assert_eq!(words[1].start, 0.5);
        assert_eq!(words[1].end, 0.9);
    }

    #[test]
    fn cjk_chars_become_individual_words() {
        let words = tokens_to_words(&[tok("你", 0, 30), tok("好", 30, 60)]);
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].word, "你");
        assert_eq!(words[1].word, "好");
        assert_eq!(words[1].start, 0.3);
        assert_eq!(words[1].end, 0.6);
    }

    #[test]
    fn split_utf8_token_buffers_until_complete() {
        // "你" = E4 BD A0 split across two tokens; span covers both.
        let b = "你".as_bytes();
        let words = tokens_to_words(&[
            RawToken {
                bytes: b[..1].to_vec(),
                t0: 10,
                t1: 20,
            },
            RawToken {
                bytes: b[1..].to_vec(),
                t0: 20,
                t1: 40,
            },
        ]);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].word, "你");
        assert_eq!(words[0].start, 0.1);
        assert_eq!(words[0].end, 0.4);
    }

    #[test]
    fn punctuation_attaches_to_previous_word() {
        let words = tokens_to_words(&[tok(" yes", 0, 20), tok(".", 20, 25)]);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].word, "yes.");

        // CJK fullwidth punctuation behaves the same.
        let words = tokens_to_words(&[tok("好", 0, 30), tok("。", 30, 35)]);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].word, "好。");
        assert_eq!(words[0].end, 0.35);
    }

    #[test]
    fn mixed_zh_en_code_switching() {
        // "我 用 GPU 跑" — zh chars individual, latin run merges.
        let words = tokens_to_words(&[
            tok("我", 0, 20),
            tok("用", 20, 40),
            tok(" GP", 40, 60),
            tok("U", 60, 70),
            tok("跑", 70, 90),
        ]);
        let texts: Vec<&str> = words.iter().map(|w| w.word.as_str()).collect();
        assert_eq!(texts, vec!["我", "用", "GPU", "跑"]);
        assert_eq!(words[2].start, 0.4);
        assert_eq!(words[2].end, 0.7);
    }

    #[test]
    fn timestamps_monotonic_and_empty_input_ok() {
        assert!(tokens_to_words(&[]).is_empty());
        let words = tokens_to_words(&[tok(" a", 0, 10), tok(" b", 10, 20), tok(" c", 20, 30)]);
        for pair in words.windows(2) {
            assert!(pair[0].start <= pair[1].start);
            assert!(pair[0].end <= pair[1].end);
        }
    }

    #[test]
    fn trailing_partial_utf8_is_dropped() {
        // A dangling lead byte never completed — must not panic, must
        // not leak U+FFFD, must still flush prior words.
        let words = tokens_to_words(&[
            tok(" ok", 0, 10),
            RawToken {
                bytes: vec![0xE4],
                t0: 10,
                t1: 20,
            },
        ]);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].word, "ok");
    }
}
