"""FastAPI entry point for the v2.1 in-process whisper-wrap server.

The lifespan handler picks a Whisper backend (CTranslate2 on Linux, pywhispercpp
on macOS by default) based on the active registry entry's variants and
`BACKEND_FORMAT` override, then eagerly loads the model so every endpoint sees
a fully-loaded backend on the first request and `/status` can always report
`model.loaded=true`.
"""

from __future__ import annotations

import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api.actions import router as actions_router
from app.api.ask import router as ask_router
from app.api.listen import router as listen_router
from app.api.meeting import router as meeting_router
from app.api.openai_compat import router as openai_compat_router
from app.api.sessions import router as sessions_router
from app.api.status import router as status_router
from app.api.transcribe import router as transcribe_router
from app.config import config, load_env_file
from app.services._whisper_backend import WhisperBackend, WhisperLoadError
from app.services.actions import load_actions, load_categories
from app.services.llm import LLMClient
from app.services.registry import (
    HARDCODED_FALLBACK_MODEL_NAME,
    RegistryError,
    load_registry,
    resolve_variant,
)
from app.services.whisper_ct2 import CTranslate2Backend

logger = logging.getLogger(__name__)


def _build_backend(
    *,
    model_dir_override: str | None,
    model_name: str | None,
    backend_format_override: str | None,
    compute_type: str,
    device: str,
    cpu_threads: int | None = None,
) -> tuple[WhisperBackend, dict]:
    """Resolve the active variant and instantiate the matching backend.

    Returns `(backend, metadata)` where metadata is a dict carrying the
    fields surfaced via `/status` (backend name, format, compute_type/quant,
    coreml_encoder_compiled).
    """
    if model_dir_override:
        model_dir = Path(model_dir_override)
        # Infer format from the directory layout
        if (model_dir / "model.bin").is_file():
            backend: WhisperBackend = CTranslate2Backend(
                model_dir=str(model_dir),
                compute_type=compute_type,
                device=device,
                cpu_threads=cpu_threads,
            )
            return backend, {
                "backend": "ctranslate2",
                "format": "ct2",
                "compute_type": compute_type,
                "local_dir": str(model_dir),
            }
        ggml_files = list(model_dir.glob("ggml-*.bin"))
        if ggml_files:
            ggml_path = ggml_files[0]
            encoder_dirs = list(model_dir.glob("ggml-*-encoder.mlmodelc"))
            encoder = str(encoder_dirs[0]) if encoder_dirs else None
            from app.services.whisper_cpp import PyWhisperCppBackend

            backend = PyWhisperCppBackend(
                model_path=str(ggml_path),
                coreml_encoder=encoder,
            )
            return backend, {
                "backend": "pywhispercpp",
                "format": "ggml",
                "quant": _infer_quant(ggml_path.name),
                "coreml_encoder_compiled": encoder is not None,
                "local_dir": str(model_dir),
            }
        raise WhisperLoadError(
            f"MODEL_DIR={model_dir_override!r} does not contain a CT2 model.bin "
            "or a ggml-*.bin file"
        )

    name = model_name or HARDCODED_FALLBACK_MODEL_NAME
    try:
        entries = load_registry()
    except RegistryError as e:
        raise WhisperLoadError(f"Cannot load registry: {e}") from e

    entry = entries.get(name)
    if entry is None:
        raise WhisperLoadError(
            f"MODEL_NAME={name!r} is not declared in registry/models.yaml"
        )

    host_platform = sys.platform  # "darwin", "linux", ...
    variant = resolve_variant(
        entry, platform=host_platform, backend_format=backend_format_override
    )

    variant_dir = Path("models") / variant["local_dir"]

    if variant["format"] == "ct2":
        backend = CTranslate2Backend(
            model_dir=str(variant_dir),
            compute_type=compute_type,
            device=device,
            cpu_threads=cpu_threads,
        )
        return backend, {
            "backend": "ctranslate2",
            "format": "ct2",
            "compute_type": variant.get("compute_type", compute_type),
            "local_dir": str(variant_dir),
        }

    # ggml branch — only reachable on darwin per resolve_variant() guard
    from app.services.whisper_cpp import PyWhisperCppBackend

    model_path = variant_dir / variant["filename"]
    encoder = variant_dir / variant["coreml_encoder"]
    backend = PyWhisperCppBackend(
        model_path=str(model_path),
        coreml_encoder=str(encoder),
    )
    return backend, {
        "backend": "pywhispercpp",
        "format": "ggml",
        "quant": variant.get("quant"),
        "coreml_encoder_compiled": True,
        "local_dir": str(variant_dir),
    }


def _infer_quant(filename: str) -> str | None:
    """Extract `q6_k` from `ggml-breeze-asr-25-q6_k.bin` for /status display."""
    stem = Path(filename).stem
    parts = stem.rsplit("-", 1)
    if len(parts) == 2 and parts[1].startswith("q"):
        return parts[1]
    if "f16" in stem.lower():
        return "f16"
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Surface .env first so subsequent reads see the developer's overrides.
    load_env_file()
    # Consistent timestamped format across our app + uvicorn + whisperx +
    # pyannote. Default uvicorn format omits timestamps; that makes trace-
    # by-grep painful when something fails 12 hours into a long meeting run.
    # ISO-ish "YYYY-MM-DD HH:MM:SS,mmm" matches what whisperx/pyannote
    # already emit so the visual columns line up across libraries.
    # Reuse uvicorn's DefaultFormatter / AccessFormatter so the colourised
    # levelprefix (INFO=green, WARNING=yellow, ERROR=red) carries through;
    # both auto-detect TTY via use_colors=None so piped/journald output stays
    # plain ASCII.
    from uvicorn.logging import AccessFormatter, DefaultFormatter

    _log_datefmt = "%Y-%m-%d %H:%M:%S"
    _app_fmt = "%(asctime)s %(levelprefix)s %(name)s | %(message)s"
    _access_fmt = (
        '%(asctime)s %(levelprefix)s %(client_addr)s - '
        '"%(request_line)s" %(status_code)s'
    )
    _root_handler = logging.StreamHandler()
    _root_handler.setFormatter(DefaultFormatter(fmt=_app_fmt, datefmt=_log_datefmt))
    logging.basicConfig(
        level=config.LOG_LEVEL,
        handlers=[_root_handler],
        force=True,  # override any handler other libs installed at import time
    )
    # uvicorn manages its own loggers (uvicorn, uvicorn.access, uvicorn.error)
    # with bare default handlers — install our formatter on each so the access
    # log ("GET /... 200 OK") also gets a timestamp. propagate=False prevents
    # double-emit through the root logger.
    for _name in ("uvicorn", "uvicorn.error"):
        _u = logging.getLogger(_name)
        _u.handlers.clear()
        _h = logging.StreamHandler()
        _h.setFormatter(DefaultFormatter(fmt=_app_fmt, datefmt=_log_datefmt))
        _u.addHandler(_h)
        _u.propagate = False
    _access = logging.getLogger("uvicorn.access")
    _access.handlers.clear()
    _h = logging.StreamHandler()
    _h.setFormatter(AccessFormatter(fmt=_access_fmt, datefmt=_log_datefmt))
    _access.addHandler(_h)
    _access.propagate = False
    logger.info("Starting whisper-wrap API server")
    config.ensure_temp_dir()

    # v2.3 persistence init: create data dirs, run Alembic to head, expose the
    # engine on app.state. Done BEFORE model loading so any schema errors fail
    # fast (engine init is sub-second; model load can take 30s on cold ANE).
    config.ensure_data_dirs()
    from alembic.config import Config as AlembicConfig

    from alembic import command as alembic_command
    from app.services.persistence import SessionLocal, build_engine

    alembic_cfg = AlembicConfig(str(Path("alembic.ini")))
    alembic_cfg.set_main_option("sqlalchemy.url", config.DATABASE_URL)
    alembic_command.upgrade(alembic_cfg, "head")

    db_engine = build_engine(config.DATABASE_URL)
    SessionLocal.configure(bind=db_engine)
    app.state.db_engine = db_engine
    logger.info("Persistence ready: %s", config.DATABASE_URL)

    load_start = time.perf_counter()
    backend, metadata = _build_backend(
        model_dir_override=config.MODEL_DIR,
        model_name=config.MODEL_NAME,
        backend_format_override=config.BACKEND_FORMAT,
        compute_type=config.COMPUTE_TYPE,
        device=config.DEVICE,
        cpu_threads=config.CPU_THREADS,
    )
    load_time_ms = int((time.perf_counter() - load_start) * 1000)

    app.state.whisper = backend
    app.state.backend_metadata = metadata
    app.state.model_dir = metadata["local_dir"]
    app.state.load_time_ms = load_time_ms
    app.state.lifespan_completed_at = time.time()

    # v2.2: VAD backend resolved once at startup; factory returns a fresh
    # instance per call so each WS session gets isolated state.
    from app.services.vad import make_vad_backend

    initial_vad = make_vad_backend(config.VAD_BACKEND)
    app.state.vad_backend_name = (
        "silero" if initial_vad.__class__.__name__ == "SileroVad" else "rms"
    )

    def vad_factory():
        return make_vad_backend(config.VAD_BACKEND)

    app.state.vad_factory = vad_factory
    logger.info("VAD backend: %s", app.state.vad_backend_name)

    # v2.4: prompt-action templates registry, served at GET /actions.
    # Read the path through the services module each call so test monkeypatching
    # of DEFAULT_REGISTRY_PATH affects lifespan-time loading.
    from app.services import actions as _actions_module

    app.state.actions = load_actions(_actions_module.DEFAULT_REGISTRY_PATH)
    app.state.action_categories = load_categories(_actions_module.DEFAULT_REGISTRY_PATH)
    logger.info(
        "Prompt-actions registry: %d entries loaded, %d categories",
        len(app.state.actions),
        len(app.state.action_categories),
    )

    app.state.llm_client = LLMClient(
        api_key=config.GEMINI_API_KEY,
        model=config.GEMINI_MODEL,
        system_prompt=config.GEMINI_SYSTEM_PROMPT,
    )
    logger.info(
        "Gemini LLM client: configured=%s, model=%s",
        app.state.llm_client.configured,
        app.state.llm_client.model,
    )

    logger.info(
        "Whisper backend ready (%s/%s) in %d ms",
        metadata["backend"],
        metadata["format"],
        load_time_ms,
    )

    # Meeting analysis: lightweight job store always available; the analyzer
    # itself is constructed lazily on the first request that passes the 503
    # preconditions, so missing HF_TOKEN / missing CT2 variant never breaks
    # server startup.
    from app.services.meeting_jobs import JobStore

    app.state.meeting_jobs = JobStore(
        ttl_seconds=config.MEETING_JOB_TTL_SECONDS,
        max_jobs=config.MEETING_MAX_JOBS,
    )
    app.state.meeting_analyzer = None

    yield

    logger.info("Shutting down whisper-wrap API server")


app = FastAPI(
    title="whisper-wrap",
    description="In-process FastAPI server for Whisper transcription, Gemini Q&A, and live PCM streaming",
    version=__version__,
    lifespan=lifespan,
)

app.include_router(transcribe_router)
app.include_router(ask_router)
app.include_router(status_router)
app.include_router(listen_router)
app.include_router(openai_compat_router)
app.include_router(actions_router)
app.include_router(sessions_router)
app.include_router(meeting_router)

# v2.4: PWA static bundle mounted at /app/. The bundle is produced by
# `make build-frontend`; if it's missing (developer hasn't run the frontend
# build yet) the mount silently no-ops so the rest of the API still works.
_pwa_dir = Path(__file__).resolve().parent / "static" / "app"
if _pwa_dir.is_dir():
    app.mount("/app", StaticFiles(directory=str(_pwa_dir), html=True), name="app")


if __name__ == "__main__":
    import uvicorn

    config.validate_port()
    uvicorn.run(app, host=config.API_HOST, port=config.API_PORT)
