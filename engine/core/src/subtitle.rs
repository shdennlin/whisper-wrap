//! SRT / WebVTT formatters — port of `app/services/subtitle_format.py`.
//! SRT uses comma as ms separator; VTT uses period + `WEBVTT` header.

pub type Cue = (f64, f64, String);

fn ts(seconds: f64, sep: char) -> String {
    let total_ms = (seconds * 1000.0).round() as u64;
    let (h, rem) = (total_ms / 3_600_000, total_ms % 3_600_000);
    let (m, rem) = (rem / 60_000, rem % 60_000);
    let (s, ms) = (rem / 1000, rem % 1000);
    format!("{h:02}:{m:02}:{s:02}{sep}{ms:03}")
}

pub fn format_srt(segments: &[Cue]) -> String {
    let cues: Vec<String> = segments
        .iter()
        .enumerate()
        .map(|(i, (start, end, text))| {
            format!(
                "{}\n{} --> {}\n{}\n",
                i + 1,
                ts(*start, ','),
                ts(*end, ','),
                text
            )
        })
        .collect();
    if cues.is_empty() {
        return String::new();
    }
    cues.join("\n") + "\n"
}

pub fn format_vtt(segments: &[Cue]) -> String {
    let cues: Vec<String> = segments
        .iter()
        .map(|(start, end, text)| format!("{} --> {}\n{}\n", ts(*start, '.'), ts(*end, '.'), text))
        .collect();
    let mut body = cues.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    format!("WEBVTT\n\n{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_matches_python_shape() {
        let cues = vec![(0.0, 1.5, "hi".into()), (1.5, 3.25, "there".into())];
        assert_eq!(
            format_srt(&cues),
            "1\n00:00:00,000 --> 00:00:01,500\nhi\n\n2\n00:00:01,500 --> 00:00:03,250\nthere\n\n"
        );
        assert_eq!(format_srt(&[]), "");
    }

    #[test]
    fn vtt_matches_python_shape() {
        let cues = vec![(0.0, 1.5, "hi".into())];
        assert_eq!(
            format_vtt(&cues),
            "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nhi\n\n"
        );
        assert_eq!(format_vtt(&[]), "WEBVTT\n\n");
    }
}
