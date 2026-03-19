import asyncio
import logging
import signal
import subprocess
from pathlib import Path
from typing import Optional

from app.config import config

logger = logging.getLogger(__name__)


class WhisperServerManager:
    """Manages the whisper-server (whisper.cpp) process lifecycle.

    Provides start, stop, and restart capabilities with health-check
    based readiness detection. When enabled, the transcription client
    can trigger a restart after a server error and retry transparently.
    """

    def __init__(self):
        self._process: Optional[subprocess.Popen] = None
        self._restart_lock = asyncio.Lock()

    @property
    def binary_path(self) -> Path:
        return config.WHISPER_BINARY_PATH

    @property
    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _build_command(self) -> list[str]:
        return [
            str(self.binary_path),
            "--host", config.WHISPER_SERVER_HOST,
            "--port", str(config.WHISPER_SERVER_PORT),
            "-m", str(config.MODEL_PATH),
            "-l", "auto",
            "-tdrz",
        ]

    def start(self) -> None:
        """Start the whisper-server process."""
        if self.is_running:
            logger.info("whisper-server is already running (PID %d)", self._process.pid)
            return

        if not self.binary_path.exists():
            raise FileNotFoundError(
                f"whisper-server binary not found at {self.binary_path}. "
                "Run 'make build-whisper' first."
            )

        cmd = self._build_command()
        logger.info("Starting whisper-server: %s", " ".join(cmd))

        self._process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        logger.info("whisper-server started with PID %d", self._process.pid)

    def stop(self) -> None:
        """Stop the whisper-server process gracefully."""
        if not self.is_running:
            logger.info("whisper-server is not running")
            self._process = None
            return

        pid = self._process.pid
        logger.info("Stopping whisper-server (PID %d)...", pid)

        self._process.send_signal(signal.SIGTERM)
        try:
            self._process.wait(timeout=10)
            logger.info("whisper-server (PID %d) stopped gracefully", pid)
        except subprocess.TimeoutExpired:
            logger.warning("whisper-server (PID %d) did not stop gracefully, killing...", pid)
            self._process.kill()
            self._process.wait(timeout=5)
            logger.info("whisper-server (PID %d) killed", pid)

        self._process = None

    async def restart(self) -> None:
        """Restart the whisper-server process with readiness check.

        Uses a lock to prevent concurrent restart attempts when multiple
        requests fail simultaneously.
        """
        async with self._restart_lock:
            logger.warning("Restarting whisper-server...")
            self.stop()

            await asyncio.sleep(1)

            self.start()

            ready = await self._wait_for_ready()
            if not ready:
                raise RuntimeError(
                    "whisper-server failed to become ready after restart"
                )
            logger.info("whisper-server restarted and ready")

    async def _wait_for_ready(
        self, timeout: float = 30, interval: float = 1.0
    ) -> bool:
        """Poll the health endpoint until the server is ready or timeout."""
        import httpx

        elapsed = 0.0
        while elapsed < timeout:
            if not self.is_running:
                logger.error("whisper-server process exited during startup")
                return False

            try:
                async with httpx.AsyncClient(timeout=3) as client:
                    resp = await client.get(f"{config.whisper_server_url}/health")
                    if resp.status_code == 200:
                        return True
            except (httpx.ConnectError, httpx.TimeoutException):
                pass

            await asyncio.sleep(interval)
            elapsed += interval

        return False


whisper_manager = WhisperServerManager()
