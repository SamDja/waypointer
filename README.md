# Sulla Via

Adds waypoints to a GPX file before uploading it to your head unit.

Upload a GPX route, find OpenStreetMap drinking water fountains within 50m of it, review/select
them in a checklist, and download a new GPX with those fountains added as waypoints.

## Development

POI lookups are backed by a local PostGIS database, not a live API call, so bring that up first
(needs Docker):

```bash
docker compose up -d postgis                 # starts Postgres+PostGIS, published on localhost:5432
```

Then, in `.env` (repo root), set `OSM_EXTRACT_URL` to a **small** Geofabrik `.osm.pbf` extract -
a city or sub-region, not a whole country, so the import finishes quickly - and run the import
once:

```bash
docker compose run --rm poi-import
```

Now the backend and frontend, side by side:

```bash
uv sync
uv run pytest
POSTGIS_URL=postgresql://waypointer:waypointer@localhost:5432/pois \
  uv run uvicorn waypointer.main:app --reload
```

```bash
cd frontend
npm install
npm run dev
```

Then open http://localhost:5173 - the Vite dev server proxies `/api/*` requests to the backend
on port 8000. See CLAUDE.md's "PostGIS POI database" section for more on the import pipeline
(re-running it, reimport thresholds, etc.) and `uv run pytest`'s own PostGIS-backed tests.

## Deployment

Docker-based, deployed to a Raspberry Pi 5 on the LAN via the included `docker-compose.yml`
(see CLAUDE.md's "Docker (production shape)" section), or anywhere else that runs a Dockerfile:

```bash
docker build -t waypointer .
docker run -p 8000:8000 waypointer
```

`docker compose run --rm poi-import` is a **one-time first-bring-up step**, not something to run
on every deploy - it always unconditionally rebuilds the whole `pois` table from a freshly
re-downloaded extract. After first bring-up, wire `postgis/update_check.sh` into a Pi-side cron
entry instead, so reimports only happen when they're actually warranted:

```bash
# crontab -e on the Pi
0 3 * * * cd /path/to/waypointer && ./postgis/update_check.sh >> postgis/state/update_check.log 2>&1
```

See CLAUDE.md's "PostGIS POI database" section for the reimport thresholds this checks.
