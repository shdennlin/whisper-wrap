import subprocess
from pathlib import Path
from typing import Optional

from app.config import config
from app.services.files import file_manager


class AudioConverter:
    """Handles audio format conversion using ffmpeg."""

    @staticmethod
    def convert_to_wav(input_path: Path, output_path: Optional[Path] = None) -> Path:
        """Convert audio file to WAV format using ffmpeg."""
        if output_path is None:
            output_path = file_manager.create_temp_file(suffix=".wav")

        cmd = [
            "ffmpeg",
            "-i",
            str(input_path),
            "-ar",
            "16000",  # Sample rate expected by whisper
            "-ac",
            "1",  # Mono channel
            "-f",
            "wav",  # Output format
            "-y",  # Overwrite output file
            str(output_path),
        ]

        try:
            result = subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                text=True,
                timeout=config.UPLOAD_TIMEOUT_SECONDS,
            )

            if not output_path.exists():
                raise RuntimeError("ffmpeg conversion failed - output file not created")

            return output_path

        except subprocess.TimeoutExpired:
            raise RuntimeError(
                f"Audio conversion timed out after {config.UPLOAD_TIMEOUT_SECONDS} seconds"
            )
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"ffmpeg conversion failed: {e.stderr}")
        except FileNotFoundError:
            raise RuntimeError("ffmpeg not found - please install ffmpeg")


audio_converter = AudioConverter()
