//! Simplified→Traditional (Taiwan) transcript conversion — the
//! zh-convert-dictionary post-process step.
//!
//! Runs after transcription to normalize Simplified Chinese output into
//! Taiwan-standard Traditional characters. Deliberately script-level only
//! (OpenCC `S2tw`, not `S2twp`): phrase/vocabulary substitution would
//! rewrite what the speaker actually said (e.g. 软件 → 軟體), sacrificing
//! transcription fidelity for localization. Character mapping preserves
//! the spoken words; it only changes the script they are written in.

use std::sync::OnceLock;

use ferrous_opencc::config::BuiltinConfig;
use ferrous_opencc::OpenCC;

/// How (whether) to convert Chinese script in transcript text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZhConvertMode {
    /// No conversion — text passes through untouched.
    Off,
    /// Simplified → Traditional (Taiwan standard), character mapping only.
    S2tw,
}

/// Convert `text` according to `mode`.
///
/// `Off` is a pure identity (the converter is never initialized).
/// `S2tw` applies OpenCC's Taiwan-standard character mapping; the
/// converter is built once and reused for every call.
pub fn convert(text: &str, mode: ZhConvertMode) -> String {
    match mode {
        ZhConvertMode::Off => text.to_owned(),
        ZhConvertMode::S2tw => s2tw_converter().convert(text),
    }
}

/// Lazily-built, process-wide S2tw converter. The dictionaries are
/// compiled into the binary, so construction failure is a programming
/// error, not a runtime condition.
fn s2tw_converter() -> &'static OpenCC {
    static CONVERTER: OnceLock<OpenCC> = OnceLock::new();
    CONVERTER.get_or_init(|| {
        OpenCC::from_config(BuiltinConfig::S2tw).expect("s2tw dictionaries are bundled")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s2tw_converts_simplified() {
        assert_eq!(convert("简体中文", ZhConvertMode::S2tw), "簡體中文");
    }

    #[test]
    fn s2tw_is_script_level_not_phrase_level() {
        // Character mapping only: 软件 → 軟件. Phrase conversion (S2twp)
        // would produce 軟體 — that would rewrite the speaker's words.
        let out = convert("软件", ZhConvertMode::S2tw);
        assert_eq!(out, "軟件");
        assert_ne!(out, "軟體");
    }

    #[test]
    fn s2tw_leaves_traditional_unchanged() {
        assert_eq!(convert("軟體開發", ZhConvertMode::S2tw), "軟體開發");
    }

    #[test]
    fn s2tw_passes_non_chinese_through() {
        assert_eq!(convert("Hello world", ZhConvertMode::S2tw), "Hello world");
    }

    #[test]
    fn off_mode_is_byte_identical() {
        assert_eq!(convert("简体中文", ZhConvertMode::Off), "简体中文");
    }

    #[test]
    fn empty_string_is_safe() {
        assert_eq!(convert("", ZhConvertMode::S2tw), "");
        assert_eq!(convert("", ZhConvertMode::Off), "");
    }
}
