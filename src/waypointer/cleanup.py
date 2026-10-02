"""Removes what's no longer needed, on a timer: expired sessions, spent or
expired email links, accounts whose email was never confirmed, and the rate
limiter's memory of addresses that have gone quiet.

The privacy notice (frontend/src/privacy) promises each of these, so this is
what keeps it true - change one side, change the other. Every step is a
plain idempotent DELETE, safe to run from any number of processes at once.
"""

import asyncio
import logging
from datetime import timedelta

import psycopg

from waypointer import db, rate_limit

# An account whose email was never confirmed is deleted this long after
# sign-up. The visitor is told (verification email, account menu, settings),
# and can always sign up again. Mirrored by the frontend's privacyConfig.ts.
UNVERIFIED_ACCOUNT_TTL = timedelta(days=7)
# How often the job runs. Expiry itself is enforced at use (an expired
# session or link is refused whether or not it's been removed yet), so this
# only bounds how long dead rows linger.
CLEANUP_INTERVAL_S = 3600.0

logger = logging.getLogger(__name__)


def purge_expired(conn: psycopg.Connection) -> dict[str, int]:
    """One pass over the account database; returns what was removed."""
    removed = {
        "sessions": conn.execute("DELETE FROM sessions WHERE expires_at <= now()").rowcount,
        # Spent or expired links are worthless - only the newest link of a
        # purpose ever works, and it works once.
        "email_tokens": conn.execute(
            "DELETE FROM email_tokens WHERE used_at IS NOT NULL OR expires_at <= now()"
        ).rowcount,
        # Sessions, links, connections and settings go with them (cascade).
        # An unverified account can't have connected an app, so there's
        # nothing to revoke elsewhere.
        "unverified_accounts": conn.execute(
            "DELETE FROM users WHERE email_verified_at IS NULL AND created_at <= now() - %s",
            (UNVERIFIED_ACCOUNT_TTL,),
        ).rowcount,
    }
    conn.commit()
    return removed


def run_once() -> None:
    """One cleanup pass. Never raises: a failed pass is logged and the next
    one tries again."""
    pruned = rate_limit.prune()
    if pruned:
        logger.info("Rate limiter forgot %d idle addresses", pruned)
    if not db.is_ready():
        return
    try:
        with db.get_pool().connection() as conn:
            removed = purge_expired(conn)
    except (db.DbError, psycopg.Error) as exc:
        logger.warning("Cleanup pass failed: %s", exc)
        return
    if any(removed.values()):
        logger.info("Cleanup removed %s", ", ".join(f"{n} {what}" for what, n in removed.items() if n))


async def run_forever() -> None:
    """The lifespan's background task: a pass at startup, then every
    CLEANUP_INTERVAL_S, until the app shuts down."""
    while True:
        await asyncio.to_thread(run_once)
        await asyncio.sleep(CLEANUP_INTERVAL_S)
