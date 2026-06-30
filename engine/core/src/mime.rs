//! MIME sniffing + supported-format gate. Port of
//! `app/services/files.py` — libmagic is replaced by the pure-Rust
//! `infer` crate (magic-byte sniffing, no system dependency).

use std::path::Path;

/// Mirrors the union of `supported_audio` + `supported_video` in the
/// Python FileManager, plus the alternate spellings `infer` emits
/// (e.g. `audio/x-flac` vs libmagic's `audio/flac`).
const SUPPORTED: &[&str] = &[
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/flac",
    "audio/x-flac",
    "audio/ogg",
    "audio/aac",
    "audio/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "audio/mp4a-latm",
    "audio/x-ms-wma",
    "audio/webm",
    "video/mp4",
    "video/avi",
    "video/x-msvideo",
    "video/quicktime",
    "video/x-matroska",
    // WebM is a video container; audio-only recordings still sniff as
    // video/webm. ffmpeg decodes the Opus stream fine, so accept it.
    "video/webm",
];

pub fn detect_mime(path: &Path) -> std::io::Result<String> {
    Ok(infer::get_from_path(path)?
        .map(|t| t.mime_type().to_owned())
        .unwrap_or_else(|| "application/octet-stream".into()))
}

pub fn is_supported_av(mime: &str) -> bool {
    SUPPORTED.contains(&mime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webm_and_m4a_are_supported() {
        assert!(is_supported_av("video/webm"));
        assert!(is_supported_av("audio/m4a"));
        assert!(is_supported_av("audio/mp4"));
    }

    #[test]
    fn text_and_unknown_are_rejected() {
        assert!(!is_supported_av("text/plain"));
        assert!(!is_supported_av("application/octet-stream"));
        assert!(!is_supported_av("application/pdf"));
    }
}
