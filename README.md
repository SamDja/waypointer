# Sulla Via

Adds waypoints to a GPX file before uploading it to your head unit.

Upload a GPX route, find OpenStreetMap drinking water fountains within 50m of it, review/select
them in a checklist, and download a new GPX with those fountains added as waypoints.

## Development

```bash
uv sync
uv run pytest
uv run uvicorn waypointer.main:app --reload
```

```bash
cd frontend
npm install
npm run dev
```

Then open http://localhost:5173. Run both the backend and `npm run dev` side by side — the
Vite dev server proxies `/api/*` requests to the backend on port 8000.

## Deployment

Docker-based, deployed to a Raspberry Pi 5 on the LAN via the included `docker-compose.yml`
(see CLAUDE.md's "Docker (production shape)" section), or anywhere else that runs a Dockerfile:

```bash
docker build -t waypointer .
docker run -p 8000:8000 waypointer
```
