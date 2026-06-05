"""In-memory job store for the meeting analysis endpoint.

Jobs are kept in a process-local dict keyed by a sortable opaque ID. They are
NOT persisted across server restarts. Eviction by TTL and capacity lives in
this module as well (`prune()` is called on every create and every get).

The store exists separately from `MeetingAnalyzer` because the two have very
different lifecycles: the store is lightweight and always available, while
the analyzer holds 1-2 GB of ML models and is loaded lazily on first use.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field

from app.services.meeting import MeetingResult

logger = logging.getLogger(__name__)


# Crockford's base32 alphabet — same as ULID. Removes I, L, O, U for clarity.
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def generate_job_id(now_ms: int | None = None) -> str:
    """Return a 26-char ULID-like sortable identifier.

    First 10 chars encode a 48-bit Unix-time-in-ms timestamp; last 16 chars
    encode 80 bits of randomness. Sortable lexicographically by creation time.
    Format matches ULID so callers can use any off-the-shelf ULID parser.
    """
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    time_part = _encode(now_ms, 10)
    rand_part = _encode(int.from_bytes(os.urandom(10), "big"), 16)
    return time_part + rand_part


def _encode(value: int, length: int) -> str:
    chars = []
    for _ in range(length):
        chars.append(_CROCKFORD[value & 0x1F])
        value >>= 5
    return "".join(reversed(chars))


JobStatus = str  # "pending" | "running" | "done" | "error"


@dataclass
class JobError:
    code: str
    message: str


@dataclass
class Job:
    job_id: str
    status: JobStatus = "pending"
    progress: float = 0.0
    stage: str = "pending"
    result: MeetingResult | None = None
    error: JobError | None = None
    created_at: float = field(default_factory=time.time)


class JobStore:
    """Process-local dict of job records with TTL + capacity eviction.

    Pass `ttl_seconds=None` to disable TTL pruning, `max_jobs=None` to disable
    capacity pruning. `clock` is injected so tests can advance time without
    real sleeps.
    """

    def __init__(
        self,
        *,
        ttl_seconds: int | None = 3600,
        max_jobs: int | None = 20,
        clock=time.time,
    ) -> None:
        self._jobs: dict[str, Job] = {}
        self._ttl_seconds = ttl_seconds
        self._max_jobs = max_jobs
        self._clock = clock

    def create(self) -> Job:
        self.prune()
        job_id = generate_job_id(now_ms=int(self._clock() * 1000))
        job = Job(job_id=job_id, created_at=self._clock())
        self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        self.prune()
        return self._jobs.get(job_id)

    def all(self) -> list[Job]:
        return list(self._jobs.values())

    def count_by_status(self, status: JobStatus) -> int:
        return sum(1 for j in self._jobs.values() if j.status == status)

    def mark_running(self, job_id: str, stage: str = "asr") -> None:
        job = self._jobs[job_id]
        job.status = "running"
        job.stage = stage
        job.progress = 0.0

    def update_progress(self, job_id: str, stage: str, progress: float) -> None:
        job = self._jobs.get(job_id)
        if job is None:
            return
        job.stage = stage
        job.progress = progress

    def mark_done(self, job_id: str, result: MeetingResult) -> None:
        job = self._jobs[job_id]
        job.status = "done"
        job.stage = "complete"
        job.progress = 1.0
        job.result = result

    def mark_error(self, job_id: str, code: str, message: str) -> None:
        job = self._jobs[job_id]
        job.status = "error"
        job.error = JobError(code=code, message=message)

    def prune(self) -> None:
        """Evict jobs older than `ttl_seconds`, then by capacity (oldest first)."""
        now = self._clock()
        if self._ttl_seconds is not None:
            expired = [
                jid
                for jid, job in self._jobs.items()
                if (now - job.created_at) > self._ttl_seconds
            ]
            for jid in expired:
                del self._jobs[jid]
        if self._max_jobs is not None and len(self._jobs) > self._max_jobs:
            overflow = len(self._jobs) - self._max_jobs
            # ULID-like IDs are time-sortable; oldest = lexicographically smallest.
            sorted_ids = sorted(self._jobs.keys())
            for jid in sorted_ids[:overflow]:
                del self._jobs[jid]
