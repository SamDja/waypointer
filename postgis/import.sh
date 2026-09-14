#!/usr/bin/env bash
# Downloads the configured Geofabrik extract and (re)builds the `pois`
# table from scratch via osm2pgsql's flex output (see import_pois.lua for
# which POI types get imported and why, and CLAUDE.md's "PostGIS POI
# database" section for the full picture). Runs inside the `poi-import`
# docker-compose service - invoked directly for a first import
# (`docker compose run --rm poi-import`), or by update_check.sh once it
# decides a reimport is due.
set -euo pipefail

: "${OSM_EXTRACT_URL:?OSM_EXTRACT_URL must be set to a Geofabrik .osm.pbf extract URL}"
: "${POSTGIS_URL:?POSTGIS_URL must be set (postgresql://user:pass@host:port/db)}"

DATA_DIR="${DATA_DIR:-/data}"
EXTRACT_PATH="${DATA_DIR}/extract.osm.pbf"

mkdir -p "${DATA_DIR}"
echo "Downloading ${OSM_EXTRACT_URL} -> ${EXTRACT_PATH}"
curl -fL --retry 3 -o "${EXTRACT_PATH}" "${OSM_EXTRACT_URL}"
EXTRACT_SIZE=$(stat -c%s "${EXTRACT_PATH}")

echo "Enabling PostGIS extension (no-op if already enabled)"
psql "${POSTGIS_URL}" -c "CREATE EXTENSION IF NOT EXISTS postgis;"

echo "Dropping any existing pois table"
psql "${POSTGIS_URL}" -c "DROP TABLE IF EXISTS pois;"

# osm2pgsql already parallelizes by default (--number-processes defaults to
# the CPU count, and parallel index creation is on unless -I disables it),
# but the defaults are picked for whatever machine runs the import - tuned
# here explicitly so the Pi (4 cores, 4-8GB RAM) doesn't get a dev
# machine's core count/cache size baked in via inherited defaults, and so
# both are one env var away from tuning without editing this script.
# --cache (default 800MB, same as osm2pgsql's own default) sizes the
# in-memory node-coordinate cache used to build way/relation geometries -
# not using --slim (see below) means this needs to cover every node in the
# *whole* extract, not just the ones matching a searchable tag, so a
# country-sized extract may need this raised well above the default if RAM
# allows; too small just means more (slower) on-disk spillover, not failure.
echo "Importing via osm2pgsql (flex output, import_pois.lua)"
osm2pgsql \
    --output=flex \
    --style=/import/import_pois.lua \
    --extra-attributes \
    --number-processes="${OSM2PGSQL_NUMBER_PROCESSES:-$(nproc)}" \
    --cache="${OSM2PGSQL_CACHE_MB:-800}" \
    -d "${POSTGIS_URL}" \
    "${EXTRACT_PATH}"

echo "Creating indexes"
psql "${POSTGIS_URL}" -c "CREATE INDEX IF NOT EXISTS pois_geom_gist ON pois USING GIST (geom);"
psql "${POSTGIS_URL}" -c "CREATE INDEX IF NOT EXISTS pois_poi_type_idx ON pois (poi_type);"

ROW_COUNT=$(psql "${POSTGIS_URL}" -tAc "SELECT count(*) FROM pois;")
echo "Import complete: ${ROW_COUNT} rows"

rm -f "${EXTRACT_PATH}"

# Consumed by update_check.sh (run on the host, outside any container) to
# decide when a reimport is worth doing - written last, after a successful
# import, so a failed run never records a false "up to date" state.
mkdir -p "$(dirname "${IMPORT_STATE_FILE:-/data/state/.last_import_state}")"
{
    echo "url=${OSM_EXTRACT_URL}"
    echo "size_bytes=${EXTRACT_SIZE}"
    echo "imported_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "${IMPORT_STATE_FILE:-/data/state/.last_import_state}"
