//! Audio decode via ffmpeg. Port of `app/services/converter.py`, with
//! one improvement: instead of writing a temp WAV and re-reading it,
//! ffmpeg streams raw f32le 16 kHz mono straight to stdout — exactly
//! the sample format whisper-rs consumes, no intermediate file.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("ffmpeg not found - please install ffmpeg")]
    FfmpegMissing,
    #[error("Audio conversion timed out after {0} seconds")]
    Timeout(u64),
    #[error("ffmpeg conversion failed: {0}")]
    Ffmpeg(String),
}

/// Decode any ffmpeg-supported input into 16 kHz mono f32 samples.
pub fn decode_to_samples(input: &Path, timeout_seconds: u64) -> Result<Vec<f32>, AudioError> {
    let mut child = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(input)
        .args(["-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AudioError::FfmpegMissing,
            _ => AudioError::Ffmpeg(e.to_string()),
        })?;

    // Read stdout fully on a thread so the timeout watch below can kill
    // a runaway ffmpeg without deadlocking on a full pipe.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        stdout.read_to_end(&mut buf).map(|_| buf)
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_seconds);
    let status = loop {
        match child
            .try_wait()
            .map_err(|e| AudioError::Ffmpeg(e.to_string()))?
        {
            Some(status) => break status,
            None if std::time::Instant::now() > deadline => {
                let _ = child.kill();
                return Err(AudioError::Timeout(timeout_seconds));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };

    let bytes = reader
        .join()
        .map_err(|_| AudioError::Ffmpeg("stdout reader panicked".into()))?
        .map_err(|e| AudioError::Ffmpeg(e.to_string()))?;

    if !status.success() {
        use std::io::Read;
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut err);
        }
        return Err(AudioError::Ffmpeg(err.trim().to_owned()));
    }

    Ok(bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}
