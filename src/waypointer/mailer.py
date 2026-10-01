"""Outgoing email (verification, password reset, email change) over SMTP.

Any SMTP relay works (Brevo, Mailgun, Amazon SES...): it's configured purely
through runtime env vars, so switching provider is a .env change. With
SMTP_HOST unset (local dev), messages are logged instead of sent, which is
also how you follow a verification link without a mail server.

Links in these emails are built from PUBLIC_BASE_URL, never from the request's
Host header - a forged Host would otherwise put an attacker's domain in a
password-reset link.
"""

import logging
import os
import smtplib
from email.message import EmailMessage

logger = logging.getLogger(__name__)


class MailError(RuntimeError):
    """The SMTP relay refused or couldn't be reached."""


def public_base_url() -> str | None:
    url = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    return url or None


def send_email(to: str, subject: str, body: str) -> None:
    host = os.environ.get("SMTP_HOST")
    sender = os.environ.get("MAIL_FROM") or "Sulla Via <no-reply@localhost>"
    if not host:
        logger.warning("SMTP_HOST unset - email not sent.\nTo: %s\nSubject: %s\n\n%s", to, subject, body)
        return

    message = EmailMessage()
    message["From"] = sender
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)

    port = int(os.environ.get("SMTP_PORT") or "587")
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASSWORD")
    try:
        # 465 is implicit TLS; anything else (587, 25, 2525) upgrades with STARTTLS.
        if port == 465:
            client = smtplib.SMTP_SSL(host, port, timeout=15)
        else:
            client = smtplib.SMTP(host, port, timeout=15)
        with client:
            if port != 465:
                client.starttls()
            if user:
                client.login(user, password or "")
            client.send_message(message)
    except (smtplib.SMTPException, OSError) as exc:
        raise MailError(str(exc)) from exc
