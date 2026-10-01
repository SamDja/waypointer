import hashlib

import pytest
import requests
import responses
from fastapi import HTTPException

from waypointer import passwords
from waypointer.rate_limit import check_rate


def test_hash_and_verify():
    hashed = passwords.hash_password("correct horse battery")
    assert hashed.startswith("$argon2id$")
    assert passwords.verify_password(hashed, "correct horse battery")
    assert not passwords.verify_password(hashed, "wrong horse battery")
    assert not passwords.verify_password("not a hash", "anything")


def test_unknown_account_never_verifies():
    assert not passwords.verify_password(None, "anything at all")


def test_length_rules(monkeypatch):
    monkeypatch.delenv(passwords.HIBP_CHECK_ENV, raising=False)
    with pytest.raises(passwords.WeakPasswordError):
        passwords.validate_password("x" * (passwords.MIN_PASSWORD_LENGTH - 1))
    with pytest.raises(passwords.WeakPasswordError):
        passwords.validate_password("x" * (passwords.MAX_PASSWORD_LENGTH + 1))
    # No composition rules: a long all-lowercase passphrase is fine.
    passwords.validate_password("alllowercasebutlong")


def _hibp_suffix(password: str) -> tuple[str, str]:
    digest = hashlib.sha1(password.encode()).hexdigest().upper()
    return digest[:5], digest[5:]


@responses.activate
def test_breached_password_refused_when_enabled(monkeypatch):
    monkeypatch.setenv(passwords.HIBP_CHECK_ENV, "1")
    prefix, suffix = _hibp_suffix("password12345")
    responses.get(passwords.HIBP_RANGE_URL + prefix, body=f"0000000000000000000000000000000000A:0\r\n{suffix}:4242\r\n")
    with pytest.raises(passwords.WeakPasswordError):
        passwords.validate_password("password12345")
    # Only the 5-character prefix was sent.
    assert responses.calls[0].request.url.endswith("/range/" + prefix)


@responses.activate
def test_padding_rows_with_zero_count_are_not_breaches():
    prefix, suffix = _hibp_suffix("a fine passphrase")
    responses.get(passwords.HIBP_RANGE_URL + prefix, body=f"{suffix}:0\r\n")
    assert not passwords.is_breached("a fine passphrase")


@responses.activate
def test_hibp_fails_open(monkeypatch):
    monkeypatch.setenv(passwords.HIBP_CHECK_ENV, "1")
    prefix, _ = _hibp_suffix("a fine passphrase")
    responses.get(passwords.HIBP_RANGE_URL + prefix, body=requests.ConnectionError("down"))
    passwords.validate_password("a fine passphrase")


def test_check_rate_keys_are_independent():
    for _ in range(2):
        check_rate("test_bucket", "a@example.com", 2, 60)
    with pytest.raises(HTTPException) as exc:
        check_rate("test_bucket", "a@example.com", 2, 60)
    assert exc.value.status_code == 429
    assert int(exc.value.headers["Retry-After"]) >= 1
    check_rate("test_bucket", "b@example.com", 2, 60)
    check_rate("other_bucket", "a@example.com", 2, 60)
