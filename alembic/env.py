"""Alembic environment.

Reads the database URL from `DATABASE_URL` env var first, falling back to
`app.config.config.DATABASE_URL`, and finally to whatever is in alembic.ini.
This three-tier precedence keeps prod, dev, and CI all happy:

- prod / docker compose: `DATABASE_URL=sqlite:////data/history.db`
- dev: `app.config` default `sqlite:///data/history.db`
- alembic offline mode without env / config: alembic.ini default
"""

from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.services.persistence.models import Base

config = context.config

if config.config_file_name is not None:
    # `disable_existing_loggers=False` is critical here: the default behaviour
    # of fileConfig is to mute every logger that existed BEFORE this call,
    # which would silence the app's own loggers (and break pytest caplog
    # capture in tests that run after this module is imported).
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _resolve_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    try:
        from app.config import config as app_cfg

        return app_cfg.DATABASE_URL
    except Exception:
        return config.get_main_option("sqlalchemy.url") or "sqlite:///data/history.db"


def run_migrations_offline() -> None:
    url = _resolve_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    config.set_main_option("sqlalchemy.url", _resolve_url())
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # required for SQLite ALTER ops
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
