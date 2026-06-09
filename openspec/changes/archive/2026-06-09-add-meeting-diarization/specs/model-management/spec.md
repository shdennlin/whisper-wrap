## ADDED Requirements

### Requirement: Download command supports diarization pre-fetch flag

The `make download-model` command (implemented by `scripts/model-manager.sh`) SHALL accept an optional `--with-diarization` flag. When the flag is present, the script SHALL, in addition to fetching the model's variants per existing rules, pre-fetch the pyannote diarization and segmentation models named by the runtime configuration (`MEETING_DIARIZATION_PIPELINE`, default `pyannote/speaker-diarization-3.1`, and its companion segmentation pipeline `pyannote/segmentation-3.0`) into the user's Hugging Face cache directory.

The script SHALL require `HF_TOKEN` to be set in the environment when `--with-diarization` is used and SHALL exit with a non-zero status and a clear error message if it is not. When the flag is absent, behaviour SHALL be unchanged from before this change.

The fetched diarization models SHALL land in the standard `$HF_HOME` (or `~/.cache/huggingface`) location used by `huggingface_hub`, so that subsequent `pyannote.audio` loads in the `MeetingAnalyzer` find them without network access.

#### Scenario: Flag triggers pyannote model fetch

- **WHEN** an operator runs `make download-model MODEL=breeze-asr-25 -- --with-diarization` with `HF_TOKEN` set in the environment
- **THEN** the script SHALL download both the ggml and ct2 variants of `breeze-asr-25` and SHALL additionally place the `pyannote/speaker-diarization-3.1` and `pyannote/segmentation-3.0` model snapshots into the Hugging Face cache directory

#### Scenario: Flag without HF_TOKEN fails fast

- **WHEN** an operator runs `make download-model MODEL=breeze-asr-25 -- --with-diarization` without `HF_TOKEN` set
- **THEN** the script SHALL exit with a non-zero status and SHALL print an error naming `HF_TOKEN` and pointing at the README "Meeting Mode — installation" section

#### Scenario: Default behaviour without the flag is unchanged

- **WHEN** an operator runs `make download-model MODEL=breeze-asr-25` without `--with-diarization`
- **THEN** the script SHALL behave identically to its pre-change behaviour and SHALL NOT attempt any pyannote downloads even when `HF_TOKEN` is set
