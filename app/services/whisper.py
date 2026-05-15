"""Public re-export of the WhisperBackend Protocol surface.

Callers SHALL import `WhisperBackend`, `TranscriptionResult`, `Segment`,
`WhisperLoadError`, `WhisperTranscriptionError`, and `WhisperBackendError`
from this module. The concrete backend instance is selected by the FastAPI
lifespan and stored on `app.state.whisper`.

Concrete backends:
  - `app.services.whisper_ct2.CTranslate2Backend` — faster-whisper / CT2 path
  - `app.services.whisper_cpp.PyWhisperCppBackend` — pywhispercpp + Core ML
"""

from app.services._whisper_backend import (
    Segment,
    TranscriptionResult,
    WhisperBackend,
    WhisperBackendError,
    WhisperLoadError,
    WhisperTranscriptionError,
)

__all__ = [
    "Segment",
    "TranscriptionResult",
    "WhisperBackend",
    "WhisperBackendError",
    "WhisperLoadError",
    "WhisperTranscriptionError",
]
