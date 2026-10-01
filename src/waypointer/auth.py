"""Account endpoints: sign-up, email verification, login/logout, password
reset, password and email changes, data export and account deletion.

Email + password, self-hosted: users and sessions live in our own database
(db.py), sessions are server-side cookies (sessions.py), passwords are
Argon2id (passwords.py). Accounts are optional - everything the app did
before still works anonymously; only connections to other apps and test-
phase features will ask for one.

Because sign-up is open to anyone, the endpoints are built not to reveal
whether an email address has an account: sign-up and "forgot password"
always answer the same way (the email itself tells the owner what happened),
and a failed login never says which half was wrong. Sign-up therefore
doesn't log you in - following the verification link does, which also proves
the address is yours before the browser holds a session for it.
"""

import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone

import psycopg
from fastapi import APIRouter, Depends, Form, HTTPException, Request, Response, status

from waypointer import db, mailer, passwords, turnstile
from waypointer.rate_limit import (
    EMAILS_PER_ADDRESS_PER_HOUR,
    HOUR_S,
    LOGIN_ATTEMPTS_PER_EMAIL,
    LOGIN_EMAIL_WINDOW_S,
    account_rate_limit,
    check_rate,
    client_ip,
    login_rate_limit,
    signup_rate_limit,
)
from waypointer.schemas import AccountResponse, AccountStatus
from waypointer.sessions import (
    USER_COLUMNS,
    User,
    clear_session_cookie,
    connection,
    current_user_optional,
    hash_token,
    new_token,
    require_same_origin,
    require_user,
    session_token,
    start_session,
    user_from_row,
)

VERIFY_TOKEN_TTL = timedelta(hours=24)
RESET_TOKEN_TTL = timedelta(minutes=30)
CHANGE_EMAIL_TOKEN_TTL = timedelta(hours=24)
# Deliberately loose - one @, something on each side, a dot in the domain.
# The verification email is the real check; a strict regex only ever refuses
# valid addresses.
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_EMAIL_LENGTH = 254

LOGIN_FAILED = "Email or password is incorrect."
BAD_LINK = "This link has expired or has already been used. Please ask for a new one."
CHECK_EMAIL = {"status": "check_email"}

logger = logging.getLogger(__name__)
router = APIRouter()


# --- helpers ---------------------------------------------------------------


def _account(user: User) -> AccountResponse:
    return AccountResponse(
        id=user.id,
        email=user.email,
        email_verified=user.email_verified,
        features=list(user.features),
        created_at=user.created_at.isoformat(),
    )


def _normalize_email(raw: str) -> str:
    email = raw.strip()
    if len(email) > MAX_EMAIL_LENGTH or not EMAIL_PATTERN.match(email):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please enter a valid email address.")
    return email


def _check_password_rules(password: str) -> None:
    try:
        passwords.validate_password(password)
    except passwords.WeakPasswordError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


def _check_captcha(request: Request, token: str | None) -> None:
    try:
        ok = turnstile.verify(token, client_ip(request))
    except turnstile.CaptchaUnavailableError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "We couldn't check the captcha - please try again.") from exc
    if not ok:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Please complete the captcha.")


def _limit_emails_to(address: str) -> None:
    check_rate("email_send", address.lower(), EMAILS_PER_ADDRESS_PER_HOUR, HOUR_S)


def _link_base(request: Request) -> str:
    """Where links in emails point. PUBLIC_BASE_URL in any real deployment;
    without one, emails are only being logged (dev), so the page's own
    origin - already checked by require_same_origin - is good enough."""
    base = mailer.public_base_url()
    if base:
        return base
    if os.environ.get("SMTP_HOST"):
        logger.error("PUBLIC_BASE_URL must be set when SMTP_HOST is.")
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Email isn't set up on this server.")
    origin = request.headers.get("origin")
    return origin.rstrip("/") if origin else str(request.base_url).rstrip("/")


def _send(to: str, subject: str, body: str) -> None:
    try:
        mailer.send_email(to, subject, body)
    except mailer.MailError as exc:
        logger.error("Sending email failed: %s", exc)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "We couldn't send the email - please try again later.") from exc


def _issue_token(
    conn: psycopg.Connection, user_id: str, purpose: str, ttl: timedelta, new_email: str | None = None
) -> str:
    # A new link replaces any earlier one for the same purpose, so only the
    # latest email works.
    conn.execute(
        "UPDATE email_tokens SET used_at = now() WHERE user_id = %s AND purpose = %s AND used_at IS NULL",
        (user_id, purpose),
    )
    token = new_token()
    conn.execute(
        "INSERT INTO email_tokens (token_hash, user_id, purpose, new_email, expires_at)"
        " VALUES (%s, %s, %s, %s, %s)",
        (hash_token(token), user_id, purpose, new_email, datetime.now(timezone.utc) + ttl),
    )
    return token


def _consume_token(conn: psycopg.Connection, token: str, purpose: str) -> tuple[str, str | None]:
    row = conn.execute(
        "UPDATE email_tokens SET used_at = now()"
        " WHERE token_hash = %s AND purpose = %s AND used_at IS NULL AND expires_at > now()"
        " RETURNING user_id::text, new_email::text",
        (hash_token(token), purpose),
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, BAD_LINK)
    return row[0], row[1]


def _load_user(conn: psycopg.Connection, user_id: str) -> User:
    row = conn.execute(f"SELECT {USER_COLUMNS} FROM users u WHERE u.id = %s", (user_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, BAD_LINK)
    return user_from_row(row)


def _password_hash(conn: psycopg.Connection, user_id: str) -> str:
    return conn.execute("SELECT password_hash FROM users WHERE id = %s", (user_id,)).fetchone()[0]


def _check_current_password(conn: psycopg.Connection, user: User, password: str) -> None:
    check_rate("login_email", user.email.lower(), LOGIN_ATTEMPTS_PER_EMAIL, LOGIN_EMAIL_WINDOW_S)
    if not passwords.verify_password(_password_hash(conn, user.id), password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Your current password is incorrect.")


def _send_verification(conn: psycopg.Connection, request: Request, user_id: str, email: str) -> None:
    token = _issue_token(conn, user_id, "verify", VERIFY_TOKEN_TTL)
    _send(
        email,
        "Confirm your Sulla Via account",
        "Welcome to Sulla Via!\n\n"
        "Confirm your email address to finish creating your account:\n\n"
        f"{_link_base(request)}/?verify={token}\n\n"
        "The link works for 24 hours. If you didn't sign up, you can ignore this email.\n",
    )


# --- status ----------------------------------------------------------------


@router.get("/api/auth/me", response_model=AccountStatus, dependencies=[Depends(account_rate_limit)])
def me(request: Request, response: Response) -> AccountStatus:
    enabled = db.is_ready()
    user = current_user_optional(request, response) if enabled else None
    return AccountStatus(
        enabled=enabled,
        account=_account(user) if user else None,
        captcha_required=turnstile.is_enabled(),
    )


# --- sign-up and verification ----------------------------------------------


@router.post(
    "/api/auth/signup",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_same_origin), Depends(signup_rate_limit)],
)
def signup(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    turnstile_token: str | None = Form(None),
) -> dict:
    email = _normalize_email(email)
    _check_password_rules(password)
    _check_captcha(request, turnstile_token)
    _limit_emails_to(email)
    # Hashed whether or not the account exists, so both answers take as long.
    password_hash = passwords.hash_password(password)
    with connection() as conn:
        row = conn.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s)"
            " ON CONFLICT (email) DO NOTHING RETURNING id::text",
            (email, password_hash),
        ).fetchone()
        if row is not None:
            _send_verification(conn, request, row[0], email)
        else:
            _send(
                email,
                "Your Sulla Via account",
                "Someone (hopefully you) tried to create a Sulla Via account with this email address,"
                " but there already is one.\n\n"
                "If you've forgotten your password, you can reset it from the sign-in form:\n\n"
                f"{_link_base(request)}/?signin=forgot\n\n"
                "If this wasn't you, you can ignore this email - nothing has changed.\n",
            )
    return CHECK_EMAIL


@router.post(
    "/api/auth/verify",
    response_model=AccountResponse,
    dependencies=[Depends(require_same_origin), Depends(account_rate_limit)],
)
def verify_email(request: Request, response: Response, token: str = Form(...)) -> AccountResponse:
    with connection() as conn:
        user_id, _ = _consume_token(conn, token, "verify")
        conn.execute(
            "UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = %s", (user_id,)
        )
        # Following the link proves the address, so it also signs you in -
        # sign-up itself deliberately doesn't (see the module docstring).
        start_session(conn, user_id, request, response)
        return _account(_load_user(conn, user_id))


@router.post(
    "/api/auth/resend-verification",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_same_origin), Depends(account_rate_limit)],
)
def resend_verification(request: Request, user: User = Depends(require_user)) -> dict:
    if user.email_verified:
        return CHECK_EMAIL
    _limit_emails_to(user.email)
    with connection() as conn:
        _send_verification(conn, request, user.id, user.email)
    return CHECK_EMAIL


# --- login and logout ------------------------------------------------------


@router.post(
    "/api/auth/login",
    response_model=AccountResponse,
    dependencies=[Depends(require_same_origin), Depends(login_rate_limit)],
)
def login(request: Request, response: Response, email: str = Form(...), password: str = Form(...)) -> AccountResponse:
    email = email.strip()
    check_rate("login_email", email.lower(), LOGIN_ATTEMPTS_PER_EMAIL, LOGIN_EMAIL_WINDOW_S)
    with connection() as conn:
        row = conn.execute(
            f"SELECT {USER_COLUMNS}, u.password_hash FROM users u WHERE u.email = %s", (email,)
        ).fetchone()
        # verify_password spends a hash check even with no account, so an
        # unknown email isn't answered measurably faster.
        if not passwords.verify_password(row[5] if row else None, password):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, LOGIN_FAILED)
        user = user_from_row(row)
        if passwords.needs_rehash(row[5]):
            conn.execute(
                "UPDATE users SET password_hash = %s WHERE id = %s", (passwords.hash_password(password), user.id)
            )
        start_session(conn, user.id, request, response)
    return _account(user)


@router.post(
    "/api/auth/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_same_origin), Depends(account_rate_limit)],
)
def logout(request: Request) -> Response:
    token = session_token(request)
    if token is not None and db.is_ready():
        with connection() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = %s", (hash_token(token),))
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session_cookie(response)
    return response


# --- password reset --------------------------------------------------------


@router.post(
    "/api/auth/forgot-password",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_same_origin), Depends(signup_rate_limit)],
)
def forgot_password(request: Request, email: str = Form(...), turnstile_token: str | None = Form(None)) -> dict:
    email = _normalize_email(email)
    _check_captcha(request, turnstile_token)
    _limit_emails_to(email)
    with connection() as conn:
        row = conn.execute("SELECT id::text, email::text FROM users WHERE email = %s", (email,)).fetchone()
        # Unknown address: the same answer, and no email - there's no one to tell.
        if row is not None:
            token = _issue_token(conn, row[0], "reset", RESET_TOKEN_TTL)
            _send(
                row[1],
                "Reset your Sulla Via password",
                "Someone (hopefully you) asked to reset the password of your Sulla Via account.\n\n"
                "Choose a new password here:\n\n"
                f"{_link_base(request)}/?reset={token}\n\n"
                "The link works once, for 30 minutes. If you didn't ask for this,"
                " you can ignore this email - your password hasn't changed.\n",
            )
    return CHECK_EMAIL


@router.post(
    "/api/auth/reset-password",
    response_model=AccountResponse,
    dependencies=[Depends(require_same_origin), Depends(account_rate_limit)],
)
def reset_password(
    request: Request, response: Response, token: str = Form(...), password: str = Form(...)
) -> AccountResponse:
    # Checked before the token is spent, so a too-short password doesn't
    # burn the link.
    _check_password_rules(password)
    with connection() as conn:
        user_id, _ = _consume_token(conn, token, "reset")
        # The reset link reached the inbox, so the address is proven too.
        conn.execute(
            "UPDATE users SET password_hash = %s, email_verified_at = coalesce(email_verified_at, now())"
            " WHERE id = %s",
            (passwords.hash_password(password), user_id),
        )
        # Whoever knew the old password is signed out everywhere.
        conn.execute("DELETE FROM sessions WHERE user_id = %s", (user_id,))
        start_session(conn, user_id, request, response)
        return _account(_load_user(conn, user_id))


# --- account settings ------------------------------------------------------


@router.post(
    "/api/account/password",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_same_origin), Depends(account_rate_limit)],
)
def change_password(
    request: Request,
    current_password: str = Form(...),
    new_password: str = Form(...),
    user: User = Depends(require_user),
) -> None:
    _check_password_rules(new_password)
    with connection() as conn:
        _check_current_password(conn, user, current_password)
        conn.execute(
            "UPDATE users SET password_hash = %s WHERE id = %s", (passwords.hash_password(new_password), user.id)
        )
        # Every other browser is signed out; this one stays signed in.
        conn.execute(
            "DELETE FROM sessions WHERE user_id = %s AND token_hash <> %s",
            (user.id, hash_token(session_token(request) or "")),
        )


@router.post(
    "/api/account/email",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_same_origin), Depends(account_rate_limit)],
)
def change_email(
    request: Request,
    password: str = Form(...),
    new_email: str = Form(...),
    user: User = Depends(require_user),
) -> dict:
    new_email = _normalize_email(new_email)
    if new_email.lower() == user.email.lower():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That's already your email address.")
    with connection() as conn:
        _check_current_password(conn, user, password)
        _limit_emails_to(new_email)
        taken = conn.execute("SELECT 1 FROM users WHERE email = %s", (new_email,)).fetchone()
        if taken:
            # Same answer as success - this mustn't become a way to test
            # which addresses have accounts.
            _send(
                new_email,
                "Your Sulla Via account",
                "Someone asked to move a Sulla Via account to this email address, but this address"
                " already has an account of its own, so nothing has changed.\n",
            )
            return CHECK_EMAIL
        token = _issue_token(conn, user.id, "change_email", CHANGE_EMAIL_TOKEN_TTL, new_email)
        _send(
            new_email,
            "Confirm your new Sulla Via email address",
            "Confirm that you want to use this address for your Sulla Via account:\n\n"
            f"{_link_base(request)}/?confirm-email={token}\n\n"
            "The link works for 24 hours. Until then, your account keeps its current address.\n",
        )
    return CHECK_EMAIL


@router.post(
    "/api/auth/confirm-email",
    response_model=AccountResponse,
    dependencies=[Depends(require_same_origin), Depends(account_rate_limit)],
)
def confirm_email(token: str = Form(...)) -> AccountResponse:
    with connection() as conn:
        user_id, new_email = _consume_token(conn, token, "change_email")
        old_email = conn.execute("SELECT email::text FROM users WHERE id = %s", (user_id,)).fetchone()[0]
        try:
            with conn.transaction():
                conn.execute(
                    "UPDATE users SET email = %s, email_verified_at = now() WHERE id = %s", (new_email, user_id)
                )
        except psycopg.errors.UniqueViolation as exc:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "That address has since been used for another account."
            ) from exc
        user = _load_user(conn, user_id)
    # Best-effort heads-up to the old address - the change is already done.
    try:
        mailer.send_email(
            old_email,
            "Your Sulla Via email address was changed",
            f"Your Sulla Via account now uses {new_email}. If you didn't do this, reply to this email.\n",
        )
    except mailer.MailError as exc:
        logger.warning("Couldn't notify the old address: %s", exc)
    return _account(user)


@router.get("/api/account/export", dependencies=[Depends(account_rate_limit)])
def export_account(user: User = Depends(require_user)) -> Response:
    with connection() as conn:
        row = conn.execute(
            "SELECT created_at, last_login_at, email_verified_at FROM users WHERE id = %s", (user.id,)
        ).fetchone()
        sessions = conn.execute(
            "SELECT created_at, last_seen_at, expires_at, user_agent FROM sessions"
            " WHERE user_id = %s ORDER BY created_at",
            (user.id,),
        ).fetchall()

    def iso(value: datetime | None) -> str | None:
        return value.isoformat() if value else None

    data = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "account": {
            "id": user.id,
            "email": user.email,
            "email_verified_at": iso(row[2]),
            "features": list(user.features),
            "created_at": iso(row[0]),
            "last_login_at": iso(row[1]),
        },
        "sessions": [
            {"created_at": iso(s[0]), "last_seen_at": iso(s[1]), "expires_at": iso(s[2]), "user_agent": s[3]}
            for s in sessions
        ],
    }
    return Response(
        json.dumps(data, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="sulla-via-account.json"'},
    )


@router.post(
    "/api/account/delete",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_same_origin), Depends(account_rate_limit)],
)
def delete_account(password: str = Form(...), user: User = Depends(require_user)) -> Response:
    with connection() as conn:
        _check_current_password(conn, user, password)
        # Sessions and email tokens go with it (ON DELETE CASCADE).
        conn.execute("DELETE FROM users WHERE id = %s", (user.id,))
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session_cookie(response)
    return response
