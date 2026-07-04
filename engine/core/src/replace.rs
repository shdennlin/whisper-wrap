//! Word-replacement dictionary application (zh-convert-dictionary).
//! Runs AFTER zh conversion in the post-process pipeline, so rules are
//! authored once in Traditional and match the converted text directly.
//!
//! Semantics: plain-substring matching, ASCII-case-insensitive, applied in
//! stored (slice) order priority, in a single pass over the text — replaced
//! output is never re-matched by other rules.

use aho_corasick::{AhoCorasick, MatchKind};

/// One word-replacement rule: replace occurrences of `from` with `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceRule {
    pub from: String,
    pub to: String,
}

/// Apply `rules` to `text` in a single pass.
///
/// - Matching is plain-substring and ASCII-case-insensitive.
/// - Earlier rules in the slice take priority when matches start at the
///   same position; the leftmost match otherwise wins.
/// - Replacement text is inserted exactly as authored and never re-matched.
/// - Rules with an empty `from` are skipped defensively (server-side
///   validation rejects them, but core must never panic on one).
pub fn apply(text: &str, rules: &[ReplaceRule]) -> String {
    // Skip empty patterns: aho-corasick would match them at every position.
    let active: Vec<&ReplaceRule> = rules.iter().filter(|r| !r.from.is_empty()).collect();
    if active.is_empty() {
        return text.to_owned();
    }

    let automaton = AhoCorasick::builder()
        .ascii_case_insensitive(true)
        // LeftmostFirst: leftmost match wins; on the same start position,
        // the earlier pattern in the list wins — i.e. stored-order priority.
        .match_kind(MatchKind::LeftmostFirst)
        .build(active.iter().map(|r| r.from.as_str()))
        .expect("non-empty plain-substring patterns always build");

    let replacements: Vec<&str> = active.iter().map(|r| r.to.as_str()).collect();
    automaton.replace_all(text, &replacements)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(from: &str, to: &str) -> ReplaceRule {
        ReplaceRule {
            from: from.into(),
            to: to.into(),
        }
    }

    #[test]
    fn casing_and_ordering() {
        let rules = [rule("Cloud Code", "Claude Code"), rule("code", "程式碼")];
        // Rule 1 matches case-insensitively; rule 2 must NOT re-match the
        // "Code" that rule 1 produced.
        assert_eq!(
            apply("open cloud code now", &rules),
            "open Claude Code now"
        );
    }

    #[test]
    fn single_pass_prevents_cascades() {
        let rules = [rule("a", "bb"), rule("b", "c")];
        // Replacement output is never re-matched: "a" → "bb", not "cc".
        assert_eq!(apply("a", &rules), "bb");
    }

    #[test]
    fn stored_order_wins_at_same_start_position() {
        assert_eq!(apply("abc", &[rule("abc", "X"), rule("ab", "Y")]), "X");
        assert_eq!(apply("abc", &[rule("ab", "Y"), rule("abc", "X")]), "Yc");
    }

    #[test]
    fn empty_rules_slice_is_identity() {
        assert_eq!(apply("open cloud code now", &[]), "open cloud code now");
    }

    #[test]
    fn empty_from_rule_is_skipped_without_panic() {
        let rules = [rule("", "BOOM"), rule("code", "程式碼")];
        assert_eq!(apply("cloud code", &rules), "cloud 程式碼");
        // Only empty-`from` rules present → identity, no panic.
        assert_eq!(apply("cloud code", &[rule("", "BOOM")]), "cloud code");
    }

    #[test]
    fn cjk_rule_matches_plainly() {
        // Plain CJK matching is unaffected by ASCII case folding.
        assert_eq!(apply("云端", &[rule("云端", "雲端硬碟")]), "雲端硬碟");
    }

    #[test]
    fn empty_text_is_safe() {
        assert_eq!(apply("", &[rule("code", "程式碼")]), "");
    }
}
