import logging
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, File, HTTPException, Request, UploadFile

from app.config import config
from app.services.converter import audio_converter
from app.services.files import file_manager
from app.services.whisper import whisper_client

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)) -> Dict[str, Any]:
    """
    Transcribe an audio file to text.

    Accepts any audio/video format and returns JSON transcription.
    """
    temp_input_file = None
    temp_wav_file = None

    try:
        # Validate file presence and set default filename if missing
        filename = file.filename or "audio.unknown"
        if not filename.strip():
            filename = "audio.unknown"

        # Create temporary file for uploaded content
        temp_input_file = file_manager.create_temp_file(suffix=Path(filename).suffix)

        # Save uploaded file
        with open(temp_input_file, "wb") as f:
            content = await file.read()
            f.write(content)

        # Validate file size
        if not file_manager.validate_file_size(temp_input_file):
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum size: {config.MAX_FILE_SIZE_MB}MB",
            )

        # Validate file type with debug info
        detected_mime = file_manager.detect_mime_type(temp_input_file)
        logger.info(
            f"Original endpoint - File: {filename}, Detected MIME: {detected_mime}, Size: {temp_input_file.stat().st_size} bytes"
        )

        if not file_manager.is_audio_file(temp_input_file):
            logger.error(
                f"Original endpoint - Unsupported format: {detected_mime} for file: {filename}"
            )
            raise HTTPException(
                status_code=415,
                detail=f"Unsupported file format. Detected: {detected_mime}. Please provide an audio or video file.",
            )

        # Convert to WAV format
        temp_wav_file = audio_converter.convert_to_wav(temp_input_file)

        # Send to whisper-server for transcription
        transcription = await whisper_client.transcribe(temp_wav_file)

        # Return the transcription result
        return transcription

    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Internal server error: {str(e)}"
        ) from e

    finally:
        # Cleanup temporary files
        if temp_input_file:
            file_manager.cleanup_file(temp_input_file)
        if temp_wav_file:
            file_manager.cleanup_file(temp_wav_file)


@router.post("/transcribe-raw")
async def transcribe_raw_audio(request: Request) -> Dict[str, Any]:
    """
    Transcribe raw audio data from request body.

    Alternative endpoint for iOS Shortcuts that sends raw binary data.
    Content-Type should indicate the audio format (e.g., audio/mp3, audio/wav).
    """
    temp_input_file = None
    temp_wav_file = None

    try:
        # Read raw body data
        body = await request.body()
        if not body:
            raise HTTPException(status_code=400, detail="No audio data provided")

        # Get content type to determine file extension
        content_type = request.headers.get("content-type", "audio/unknown")

        # Map content types to file extensions
        extension_map = {
            "audio/mpeg": ".mp3",
            "audio/mp3": ".mp3",
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
            "audio/flac": ".flac",
            "audio/ogg": ".ogg",
            "audio/aac": ".aac",
            "audio/mp4": ".m4a",
            "video/mp4": ".mp4",
            "video/quicktime": ".mov",
        }

        extension = extension_map.get(content_type, ".audio")

        # Create temporary file
        temp_input_file = file_manager.create_temp_file(suffix=extension)

        # Write raw data to file
        with open(temp_input_file, "wb") as f:
            f.write(body)

        # Validate file size
        if not file_manager.validate_file_size(temp_input_file):
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum size: {config.MAX_FILE_SIZE_MB}MB",
            )

        # Validate file type with debug info (this will detect actual format regardless of extension)
        detected_mime = file_manager.detect_mime_type(temp_input_file)
        logger.info(
            f"Raw endpoint - Content-Type header: {content_type}, Extension: {extension}, Detected MIME: {detected_mime}, Size: {len(body)} bytes"
        )

        if not file_manager.is_audio_file(temp_input_file):
            logger.error(
                f"Raw endpoint - Unsupported format: {detected_mime} (Content-Type: {content_type}, Extension: {extension})"
            )
            raise HTTPException(
                status_code=415,
                detail=f"Unsupported file format. Header: {content_type}, Detected: {detected_mime}. Please provide an audio or video file.",
            )

        # Convert to WAV format
        temp_wav_file = audio_converter.convert_to_wav(temp_input_file)

        # Send to whisper-server for transcription
        transcription = await whisper_client.transcribe(temp_wav_file)

        # Return the transcription result
        return transcription

    except HTTPException:
        raise
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Internal server error: {str(e)}"
        ) from e

    finally:
        # Cleanup temporary files
        if temp_input_file:
            file_manager.cleanup_file(temp_input_file)
        if temp_wav_file:
            file_manager.cleanup_file(temp_wav_file)
