"""The app's own database: accounts and sessions (auth.py, sessions.py).

Deliberately a separate database from the OSM import's `pois` (poi_db.py),
on the same Postgres server: the POI import drops and rebuilds its table
from scratch, and account data has nothing to do with it - kept apart, the
two never touch and can be backed up or restored independently.

`DATABASE_URL` names it (e.g. postgresql://waypointer:...@postgis:5432/sulla_via).
At startup, `init_database()` creates the database if it's missing (the
compose user is the server's superuser) and applies any `migrations/*.sql`
not yet recorded in `schema_migrations` - Postgres' initdb scripts only run
against a fresh, empty data directory, so they'd never reach an existing
deployment's volume. With `DATABASE_URL` unset, nothing account-related
works (every account endpoint answers 503) but the rest of the app does.
"""

import logging
import os
import threading
import time
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg_pool import ConnectionPool

DATABASE_URL_ENV = "DATABASE_URL"
MIGRATIONS_DIR = Path(__file__).parent / "migrations"
# Arbitrary, fixed: held while migrating so two processes starting at once
# can't both apply the same migration.
_MIGRATION_LOCK_ID = 7_301_955

logger = logging.getLogger(__name__)


class DbError(RuntimeError):
    """The account database is unavailable or unconfigured."""


# How long after a failed initialisation before the next request may try
# again - so a database that was still starting when the app booted is picked
# up without a restart, without every request hammering it meanwhile.
RETRY_INIT_AFTER_S = 30.0

_pool: ConnectionPool | None = None
_ready = False
_last_attempt = 0.0
_init_lock = threading.Lock()


def database_url() -> str:
    url = os.environ.get(DATABASE_URL_ENV)
    if not url:
        raise DbError(f"{DATABASE_URL_ENV} is not set.")
    return url


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(database_url(), min_size=1, max_size=8, open=True)
    return _pool


def close_pool() -> None:
    global _pool, _ready
    _ready = False
    if _pool is not None:
        _pool.close()
        _pool = None


def ensure_database(url: str) -> None:
    """Creates the database `url` names if it doesn't exist yet, by connecting
    to the server's `postgres` maintenance database with the same
    credentials."""
    params = conninfo_to_dict(url)
    name = params.get("dbname")
    if not name:
        raise DbError(f"{DATABASE_URL_ENV} must name a database.")
    try:
        with psycopg.connect(url, connect_timeout=5):
            return
    except psycopg.OperationalError as exc:
        # Anything other than "that database doesn't exist" (wrong password,
        # server down) is not ours to fix by creating one.
        if "does not exist" not in str(exc):
            raise DbError(f"Can't connect to the account database: {exc}") from exc
    maintenance = make_conninfo(url, dbname="postgres")
    with psycopg.connect(maintenance, autocommit=True, connect_timeout=5) as conn:
        # From template0 rather than the default template1: it's pristine (no
        # objects anyone added to template1), and an older volume's template1
        # can carry a stale collation version that makes Postgres refuse to
        # copy it after an OS/glibc upgrade in the image.
        conn.execute(
            sql.SQL("CREATE DATABASE {} TEMPLATE template0 ENCODING 'UTF8'").format(sql.Identifier(name))
        )
    logger.info("Created database %s", name)


def apply_migrations(conn: psycopg.Connection) -> list[str]:
    """Applies every migrations/NNN_*.sql not yet recorded, in name order,
    each in its own transaction. Returns the names applied."""
    applied: list[str] = []
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    )
    conn.commit()
    conn.execute("SELECT pg_advisory_lock(%s)", (_MIGRATION_LOCK_ID,))
    try:
        done = {row[0] for row in conn.execute("SELECT name FROM schema_migrations")}
        conn.commit()
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in done:
                continue
            with conn.transaction():
                conn.execute(path.read_text())
                conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
            applied.append(path.name)
    finally:
        conn.execute("SELECT pg_advisory_unlock(%s)", (_MIGRATION_LOCK_ID,))
        conn.commit()
    return applied


def is_configured() -> bool:
    return bool(os.environ.get(DATABASE_URL_ENV))


def is_ready() -> bool:
    """Whether the account database is initialised, retrying a failed
    initialisation at most every RETRY_INIT_AFTER_S."""
    if not is_configured():
        return False
    if _ready:
        return True
    if time.monotonic() - _last_attempt < RETRY_INIT_AFTER_S:
        return False
    return init_database()


def init_database() -> bool:
    """Startup hook: create the database if needed and migrate it. Returns
    False (and logs why) rather than raising, so a missing or unreachable
    account database never stops the rest of the app from serving."""
    global _ready, _last_attempt
    with _init_lock:
        _last_attempt = time.monotonic()
        _ready = _init_database()
        return _ready


def _init_database() -> bool:
    try:
        url = database_url()
    except DbError:
        logger.warning("%s is not set - accounts are disabled.", DATABASE_URL_ENV)
        return False
    try:
        ensure_database(url)
        with psycopg.connect(url) as conn:
            applied = apply_migrations(conn)
    except (DbError, psycopg.Error) as exc:
        logger.error("Account database unavailable - accounts are disabled: %s", exc)
        return False
    if applied:
        logger.info("Applied migrations: %s", ", ".join(applied))
    return True
