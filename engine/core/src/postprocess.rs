//! Transcription post-process filter. Pure port of
//! `app/services/postprocess.py` — single source of truth for
//! "is this Whisper output noise or content?".

/// ASCII + CJK punctuation Whisper emits in hallucinated/noise output.
/// Mirrors `_PUNCT_CHARS` in the Python module exactly.
const PUNCT_CHARS: &str = ".,!?;:'\"`-_*~/\\()[]{}<>。，、；：？！「」『』（）《》〈〉…—·";

#[derive(Debug, PartialEq, Eq)]
pub enum FilterDecision {
    Keep(String),
    Drop(DropReason),
}

#[derive(Debug, PartialEq, Eq)]
pub enum DropReason {
    EmptyText,
    BelowMinDuration,
}

impl DropReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            DropReason::EmptyText => "empty_text",
            DropReason::BelowMinDuration => "below_min_duration",
        }
    }
}

/// Decide whether a transcription result is content or noise.
/// `duration_ms = None` skips the duration check (the /transcribe path).
pub fn filter_empty_transcription(
    text: &str,
    duration_ms: Option<f64>,
    enabled: bool,
    min_duration_ms: u64,
) -> FilterDecision {
    if !enabled {
        return FilterDecision::Keep(text.to_owned());
    }
    if let Some(d) = duration_ms {
        if d < min_duration_ms as f64 {
            return FilterDecision::Drop(DropReason::BelowMinDuration);
        }
    }
    if is_empty_after_stripping(text) {
        return FilterDecision::Drop(DropReason::EmptyText);
    }
    FilterDecision::Keep(text.to_owned())
}

fn is_empty_after_stripping(text: &str) -> bool {
    text.chars()
        .all(|c| c.is_whitespace() || PUNCT_CHARS.contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_real_content() {
        assert_eq!(
            filter_empty_transcription("你好 world", None, true, 500),
            FilterDecision::Keep("你好 world".into())
        );
    }

    #[test]
    fn drops_pure_punctuation_and_whitespace() {
        for noise in ["", "   ", "。。。", " .,!? ", "「」…—·", "\n\t"] {
            assert_eq!(
                filter_empty_transcription(noise, None, true, 500),
                FilterDecision::Drop(DropReason::EmptyText),
                "should drop {noise:?}"
            );
        }
    }

    #[test]
    fn apostrophe_inside_word_is_kept() {
        // "don't" must survive — the Python module explicitly avoids
        // stripping apostrophes that carry content.
        assert_eq!(
            filter_empty_transcription("don't", None, true, 500),
            FilterDecision::Keep("don't".into())
        );
    }

    #[test]
    fn duration_check_applies_only_when_measured() {
        assert_eq!(
            filter_empty_transcription("hi", Some(100.0), true, 500),
            FilterDecision::Drop(DropReason::BelowMinDuration)
        );
        assert_eq!(
            filter_empty_transcription("hi", None, true, 500),
            FilterDecision::Keep("hi".into())
        );
    }

    #[test]
    fn kill_switch_keeps_everything() {
        assert_eq!(
            filter_empty_transcription("。", None, false, 500),
            FilterDecision::Keep("。".into())
        );
    }
}
