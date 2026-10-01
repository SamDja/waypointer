"""Password hashing and the password rules.

Argon2id via argon2-cffi's defaults (RFC 9106's low-memory profile), which
the library raises over time - `needs_rehash` lets a login upgrade an old
hash transparently. The rules follow NIST SP 800-63B: a minimum length and
nothing else (composition rules make passwords worse, not better), plus an
optional check against known breached passwords.
"""

import hashlib
import logging
import os

import requests
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from waypointer.routing import USER_AGENT

MIN_PASSWORD_LENGTH = 10
# Argon2 hashes any length, but an unbounded field is a free CPU sink.
MAX_PASSWORD_LENGTH = 256
# "1" turns on the Have I Been Pwned check. Off by default: it's a third-party
# call on every sign-up and password change.
HIBP_CHECK_ENV = "HIBP_CHECK"
HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/"
HIBP_TIMEOUT_S = 3.0

logger = logging.getLogger(__name__)
_hasher = PasswordHasher()
# Verified against when the email is unknown, so a login for a non-existent
# account costs the same time as one with a wrong password.
_DUMMY_HASH = _hasher.hash("not a real password, only spent for timing")


class WeakPasswordError(ValueError):
    """A password the rules refuse. The message is shown to the visitor."""


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """True if `password` matches. With no hash (unknown account), still
    spends a verification so the answer takes as long either way."""
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def is_breached(password: str, session: requests.Session | None = None) -> bool:
    """Whether HIBP's Pwned Passwords lists this password. k-anonymity: only
    the first 5 hex characters of its SHA-1 leave this server. Fails open -
    an unreachable HIBP must not block sign-ups."""
    digest = hashlib.sha1(password.encode()).hexdigest().upper()
    prefix, suffix = digest[:5], digest[5:]
    try:
        response = (session or requests).get(
            HIBP_RANGE_URL + prefix,
            headers={"User-Agent": USER_AGENT, "Add-Padding": "true"},
            timeout=HIBP_TIMEOUT_S,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        logger.warning("HIBP check skipped: %s", exc)
        return False
    for line in response.text.splitlines():
        candidate, _, count = line.partition(":")
        if candidate.strip() == suffix and count.strip() not in ("", "0"):
            return True
    return False


def validate_password(password: str, session: requests.Session | None = None) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise WeakPasswordError(f"Use at least {MIN_PASSWORD_LENGTH} characters.")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise WeakPasswordError(f"Use at most {MAX_PASSWORD_LENGTH} characters.")
    if os.environ.get(HIBP_CHECK_ENV) == "1" and is_breached(password, session):
        raise WeakPasswordError(
            "This password has appeared in a data breach - please choose another one."
        )
