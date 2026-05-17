"""SQLite persistence layer for sessions, finals, and AI action runs.

The package owns three concerns:
  - engine.py: SQLAlchemy 2.0 engine + session factory + per-request `get_db`
  - models.py: Declarative table definitions (Session, Final, ActionRun)
  - sessions_repo.py: Pure data-access functions used by the API layer

Layout intentionally mirrors `app/services/` style — small focused modules
re-exported here so callers can `from app.services.persistence import ...`
without learning the internal split.
"""

from app.services.persistence.engine import (
    SessionLocal,
    build_engine,
    get_db,
)
from app.services.persistence.models import (
    ActionRun,
    Base,
    Final,
    Session as SessionModel,
)
from app.services.persistence import sessions_repo

__all__ = [
    "ActionRun",
    "Base",
    "Final",
    "SessionLocal",
    "SessionModel",
    "build_engine",
    "get_db",
    "sessions_repo",
]
