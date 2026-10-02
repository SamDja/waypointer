"""Encryption at rest for the Strava/Wahoo tokens stored with an account
(connections.py).

Fernet (AES-128-CBC + HMAC-SHA256, from `cryptography`): authenticated, so a
tampered ciphertext fails to decrypt rather than yielding garbage.
TOKEN_ENCRYPTION_KEY is runtime env, kept in the server's .env and never in
the repo or the database - a leaked database or backup then holds no usable
tokens. Generate one with:

    uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

Rotation: set a comma-separated list, newest first. Everything is encrypted
with the first key and decrypted with whichever matches, and each token is
re-encrypted with the newest key the next time it's refreshed.
"""

import os

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

TOKEN_ENCRYPTION_KEY_ENV = "TOKEN_ENCRYPTION_KEY"


class TokenCryptoError(RuntimeError):
    """No usable key is configured, or a stored token can't be decrypted."""


def _fernet() -> MultiFernet:
    raw = os.environ.get(TOKEN_ENCRYPTION_KEY_ENV, "")
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    if not keys:
        raise TokenCryptoError(f"{TOKEN_ENCRYPTION_KEY_ENV} is not set.")
    try:
        return MultiFernet([Fernet(k) for k in keys])
    except ValueError as exc:
        raise TokenCryptoError(f"{TOKEN_ENCRYPTION_KEY_ENV} isn't a valid Fernet key: {exc}") from exc


def is_configured() -> bool:
    try:
        _fernet()
    except TokenCryptoError:
        return False
    return True


def encrypt(value: str) -> bytes:
    return _fernet().encrypt(value.encode())


def decrypt(value: bytes) -> str:
    try:
        return _fernet().decrypt(bytes(value)).decode()
    except InvalidToken as exc:
        raise TokenCryptoError("A stored token couldn't be decrypted - was the key changed?") from exc
