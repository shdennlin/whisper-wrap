"""SQLAlchemy 2.0 engine + session factory.

Single-writer SQLite is the assumed runtime model — FastAPI runs as one
process with a thread pool, so `check_same_thread=False` is required and
`pool_pre_ping=True` guards against stale connections. The module exposes:

- `build_engine(url)`: factory that returns a new Engine for a given URL.
  Used at startup with `Config.DATABASE_URL` and in tests with `:memory:`.
- `SessionLocal`: a module-level `sessionmaker` rebound by lifespan via
  `SessionLocal.configure(bind=...)` once the production engine exists.
- `get_db()`: FastAPI dependency that yields a Session and closes it after.
"""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session as SASession
from sqlalchemy.orm import sessionmaker


def build_engine(database_url: str) -> Engine:
    """Construct a SQLAlchemy Engine appropriate for SQLite + FastAPI."""
    connect_args: dict = {}
    if database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
    return create_engine(
        database_url,
        connect_args=connect_args,
        pool_pre_ping=True,
        future=True,
    )


# Created unbound; lifespan binds it to the real engine via
# `SessionLocal.configure(bind=engine)`. Tests can do the same against
# `build_engine("sqlite:///:memory:")` without touching production state.
SessionLocal: sessionmaker[SASession] = sessionmaker(
    autoflush=False, autocommit=False, expire_on_commit=False, future=True
)


def get_db() -> Generator[SASession, None, None]:
    """Yield a Session, ensuring it's closed after the request scope ends."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
