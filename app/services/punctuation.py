"""Post-processing for whisper transcription output.

Whisper models (especially multilingual ones like Breeze ASR 25) may:
1. Use newlines instead of spaces as segment separators
2. Produce Chinese punctuation marks for English text or vice versa

This module detects the dominant language from the text content itself,
joins newline-separated segments with spaces, and normalizes punctuation
style to match the detected language.
"""

import re
import unicodedata

# CJK Unicode ranges for language detection (excludes punctuation ranges
# to avoid inflating CJK ratio with punctuation characters)
_CJK_PATTERN = re.compile(
    r"[\u4e00-\u9fff"  # CJK Unified Ideographs
    r"\u3400-\u4dbf"   # CJK Unified Ideographs Extension A
    r"\uf900-\ufaff"   # CJK Compatibility Ideographs
    r"\u2e80-\u2eff"   # CJK Radicals Supplement
    r"]"
)

# Punctuation mapping: Chinese → English
_ZH_TO_EN = str.maketrans({
    "\uff0c": ",",   # ，
    "\u3002": ".",   # 。
    "\uff1f": "?",   # ？
    "\uff01": "!",   # ！
    "\uff1a": ":",   # ：
    "\uff1b": ";",   # ；
    "\u300c": '"',   # 「
    "\u300d": '"',   # 」
    "\u300e": '"',   # 『
    "\u300f": '"',   # 』
    "\uff08": "(",   # （
    "\uff09": ")",   # ）
})

# Punctuation mapping: English → Chinese (only fullwidth punctuation,
# excludes . and , to avoid corrupting numbers like 3.14 or 1,000)
_EN_TO_ZH = str.maketrans({
    "?": "\uff1f",   # ？
    "!": "\uff01",   # ！
    ":": "\uff1a",   # ：
    ";": "\uff1b",   # ；
})


def detect_text_language(text: str) -> str:
    """Detect dominant language from text content.

    Returns "zh" if CJK characters make up the majority of letter characters,
    otherwise returns "en". Single-pass over the text.
    """
    if not text.strip():
        return "en"

    cjk_count = 0
    latin_count = 0
    for ch in text:
        if _CJK_PATTERN.match(ch):
            cjk_count += 1
        elif unicodedata.category(ch).startswith("L") and ord(ch) < 0x2e80:
            latin_count += 1

    if cjk_count == 0 and latin_count == 0:
        return "en"

    total = cjk_count + latin_count
    return "zh" if cjk_count / total > 0.5 else "en"


def join_newline_segments(text: str) -> str:
    """Join newline-separated segments with spaces.

    Many whisper models (especially Breeze ASR 25) output newlines as
    segment separators. This replaces them with spaces, preserving any
    existing punctuation.
    """
    if "\n" not in text:
        return text

    segments = [s.strip() for s in text.split("\n") if s.strip()]
    return " ".join(segments)


def normalize_punctuation(text: str, target_language: str | None = None) -> str:
    """Normalize punctuation to match the target language.

    If target_language is None, auto-detects from the text content.
    If target_language is "en", converts Chinese punctuation to English.
    If target_language is "zh", converts English punctuation to Chinese.
    """
    if not text:
        return text

    if target_language is None:
        target_language = detect_text_language(text)

    if target_language == "en":
        return text.translate(_ZH_TO_EN)
    elif target_language == "zh":
        return text.translate(_EN_TO_ZH)

    return text
