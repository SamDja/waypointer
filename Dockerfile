# ---- frontend build stage ----
FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Non-secret PKCE public-client id (see frontend/src/lib/wahooConfig.ts) -
# Vite env vars are baked in at build time, so this must be a build ARG, not
# a runtime CMD env var. Render forwards a dashboard-set env var of the same
# name as an automatic build arg for Docker-runtime services.
ARG VITE_WAHOO_CLIENT_ID
ENV VITE_WAHOO_CLIENT_ID=$VITE_WAHOO_CLIENT_ID
# Not secret - just identifies the public Tally feedback form (see
# frontend/src/lib/feedbackConfig.ts) - same build-arg reasoning as above.
ARG VITE_TALLY_FORM_ID
ENV VITE_TALLY_FORM_ID=$VITE_TALLY_FORM_ID
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

# Render (and most PaaS free tiers) inject $PORT at runtime; default to 8000
# for local `docker run`.
CMD ["sh", "-c", "uv run uvicorn waypointer.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
