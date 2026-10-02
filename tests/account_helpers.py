"""Helpers shared by the account tests (test_auth.py, test_connections.py);
their fixtures live in conftest.py."""

import re

ACCOUNT_PASSWORD = "correct horse battery"


def link_token(mail: dict, param: str) -> str:
    match = re.search(rf"\?{param}=([\w-]+)", mail["body"])
    assert match, mail["body"]
    return match.group(1)


def signup_and_verify(client, outbox, email="rider@example.com", password=ACCOUNT_PASSWORD) -> dict:
    """Creates a verified account and leaves `client` signed in to it."""
    assert client.post("/api/auth/signup", data={"accept_privacy": "true", "name": "Ada", "email": email, "password": password}).status_code == 202
    response = client.post("/api/auth/verify", data={"token": link_token(outbox[-1], "verify")})
    assert response.status_code == 200
    return response.json()
