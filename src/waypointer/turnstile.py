"""Cloudflare Turnstile, the captcha on sign-up and password reset.

TURNSTILE_SECRET_KEY is runtime env (the matching site key reaches the
frontend as the VITE_TURNSTILE_SITE_KEY build arg). With no secret set the
check is skipped, which is what local dev and the tests rely on - a
deployment with open sign-up should always set it.
"""

import os

import requests

SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TIMEOUT_S = 5.0


class CaptchaUnavailableError(RuntimeError):
    """Cloudflare couldn't be asked."""


def is_enabled() -> bool:
    return bool(os.environ.get("TURNSTILE_SECRET_KEY"))


def verify(token: str | None, remote_ip: str | None, session: requests.Session | None = None) -> bool:
    secret = os.environ.get("TURNSTILE_SECRET_KEY")
    if not secret:
        return True
    if not token:
        return False
    data = {"secret": secret, "response": token}
    if remote_ip:
        data["remoteip"] = remote_ip
    try:
        response = (session or requests).post(SITEVERIFY_URL, data=data, timeout=TIMEOUT_S)
        response.raise_for_status()
        return bool(response.json().get("success"))
    except (requests.RequestException, ValueError) as exc:
        raise CaptchaUnavailableError(str(exc)) from exc
