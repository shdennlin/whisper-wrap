from app.services.punctuation import (
    detect_text_language,
    join_newline_segments,
    normalize_punctuation,
)


def test_detect_english_text():
    assert detect_text_language("Hello, how are you?") == "en"


def test_detect_chinese_text():
    assert detect_text_language("你好，你好嗎？") == "zh"


def test_detect_mixed_mostly_english():
    assert detect_text_language("Hello world 你好") == "en"


def test_detect_mixed_mostly_chinese():
    assert detect_text_language("你好世界今天天氣很好 hello") == "zh"


def test_detect_empty_text():
    assert detect_text_language("") == "en"


def test_normalize_chinese_punct_to_english():
    text = "Hello，how are you？I am fine。"
    result = normalize_punctuation(text, target_language="en")
    assert result == "Hello,how are you?I am fine."


def test_normalize_english_punct_to_chinese():
    text = "你好?我很好!"
    result = normalize_punctuation(text, target_language="zh")
    assert result == "你好\uff1f我很好\uff01"


def test_normalize_en_to_zh_preserves_numbers():
    """Periods and commas in numbers should not be corrupted."""
    text = "價格是3.14元, 共1,000個"
    result = normalize_punctuation(text, target_language="zh")
    assert "3.14" in result
    assert "1,000" in result


def test_normalize_auto_detect_english():
    text = "And so，my fellow Americans，ask not what your country can do for you。"
    result = normalize_punctuation(text)
    assert result == "And so,my fellow Americans,ask not what your country can do for you."


def test_normalize_auto_detect_chinese():
    text = "今天天氣很好? 我們去散步吧!"
    result = normalize_punctuation(text)
    assert result == "今天天氣很好\uff1f 我們去散步吧\uff01"


def test_normalize_empty_text():
    assert normalize_punctuation("") == ""


def test_normalize_no_change_needed():
    text = "Hello, how are you?"
    assert normalize_punctuation(text, target_language="en") == text


# --- join_newline_segments tests ---


def test_newline_join_english():
    text = "Hello world\nHow are you\nI am fine"
    result = join_newline_segments(text)
    assert result == "Hello world How are you I am fine"


def test_newline_join_chinese():
    text = "測試一下\n我想看看有沒有標點符號\n例如逗號"
    result = join_newline_segments(text)
    assert result == "測試一下 我想看看有沒有標點符號 例如逗號"


def test_newline_preserves_existing_punctuation():
    text = "Hello world.\nHow are you?\nI am fine"
    result = join_newline_segments(text)
    assert result == "Hello world. How are you? I am fine"


def test_newline_no_newlines():
    text = "Hello world"
    result = join_newline_segments(text)
    assert result == "Hello world"


def test_newline_empty_segments():
    text = "Hello\n\nWorld"
    result = join_newline_segments(text)
    assert result == "Hello World"


def test_newline_real_breeze_chinese_output():
    """Test with actual Breeze ASR 25 Chinese output pattern."""
    text = "測試一下測試一下中文測試\n我想看看有沒有標點符號\n例如\n逗號\n句號\n或者好或其他符號"
    result = join_newline_segments(text)
    assert "\n" not in result


def test_newline_real_breeze_english_output():
    """Test with actual Breeze ASR 25 English output pattern."""
    text = "Testing this is the English testing\nHow's it going you?"
    result = join_newline_segments(text)
    assert "\n" not in result
    assert "How's it going you?" in result


def test_newline_real_breeze_mixed_output():
    """Test with actual Breeze ASR 25 mixed-language output pattern."""
    text = "I'm not sure this is correct and today I built a web it called the Vertica.\nChinese name is投資績效審核\ncapital source and other\n也有一個說明介面譬如有績效報酬 SIR 等等"
    result = join_newline_segments(text)
    assert "\n" not in result
    assert "Vertica." in result
