# ---- frontend build stage ----
FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Non-secret PKCE public-client id (see frontend/src/lib/wahooConfig.ts) -
# Vite env vars are baked in at build time, so this must be a build ARG, not
# a runtime CMD env var. docker-compose.yml forwards it as a build arg (see
# `build.args` there) sourced from the host's .env file.
ARG VITE_WAHOO_CLIENT_ID
ENV VITE_WAHOO_CLIENT_ID=$VITE_WAHOO_CLIENT_ID
# Not secret - just identifies the public Tally feedback form (see
# frontend/src/lib/feedbackConfig.ts) - same build-arg reasoning as above.
ARG VITE_TALLY_FORM_ID
ENV VITE_TALLY_FORM_ID=$VITE_TALLY_FORM_ID
# Not secret - a public Umami dashboard id (see
# frontend/src/lib/analyticsConfig.ts) - same build-arg reasoning as above.
# Leaving it unset disables analytics entirely (see lib/analytics.ts).
ARG VITE_UMAMI_WEBSITE_ID
ENV VITE_UMAMI_WEBSITE_ID=$VITE_UMAMI_WEBSITE_ID
RUN npm run build

# ---- python stage ----
FROM python:3.11-slim

RUN pip install --no-cache-dir uv

WORKDIR /app

# Install dependencies first so they're cached separately from source changes.
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev --frozen --no-install-project

COPY src ./src
COPY README.md ./
RUN uv sync --no-dev --frozen

COPY --from=frontend-build /app/frontend/dist ./frontend/dist

EXPOSE 8000

# $PORT defaults to 8000 for local `docker run`/`docker compose up`; the
# compose file remaps it to 443 on the host (see docker-compose.yml) so the
# Pi's LAN URL has no port suffix. SSL_KEYFILE/SSL_CERTFILE are unset by
# default (plain HTTP) - when set, they point at a bind-mounted cert for
# local HTTPS on the Pi; see CLAUDE.md's "Local HTTPS" section.
CMD ["sh", "-c", "uv run uvicorn waypointer.main:app --host 0.0.0.0 --port ${PORT:-8000} ${SSL_KEYFILE:+--ssl-keyfile $SSL_KEYFILE --ssl-certfile $SSL_CERTFILE}"]
