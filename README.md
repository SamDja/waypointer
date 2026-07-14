# waypointer

Adds waypoints to a GPX file before uploading it to your head unit.

Upload a GPX route, find OpenStreetMap drinking water fountains within 50m of it, review/select
them in a checklist, and download a new GPX with those fountains added as waypoints.

## Development

```bash
uv sync
uv run pytest
uv run uvicorn waypointer.main:app --reload
```

Then open http://localhost:8000.

## Deployment

Docker-based, deployable on [Render](https://render.com)'s free tier via the included
`render.yaml` blueprint, or anywhere else that runs a Dockerfile:

```bash
docker build -t waypointer .
docker run -p 8000:8000 waypointer
```
