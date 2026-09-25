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
FILTERED_PATH="${DATA_DIR}/filtered.osm.pbf"

mkdir -p "${DATA_DIR}"
echo "Downloading ${OSM_EXTRACT_URL} -> ${EXTRACT_PATH}"
curl -fL --retry 3 -o "${EXTRACT_PATH}" "${OSM_EXTRACT_URL}"
EXTRACT_SIZE=$(stat -c%s "${EXTRACT_PATH}")

# Cut the extract down before osm2pgsql sees it (see prefilter.txt for
# why): osm2pgsql's read + Lua stage is single-threaded, osmium's PBF
# decoding isn't, so this turns hours on a country extract into minutes.
# Done before the DROP below so the live table stays queryable meanwhile.
echo "Pre-filtering with osmium tags-filter (prefilter.txt)"
osmium tags-filter --overwrite \
    -e /import/prefilter.txt \
    -o "${FILTERED_PATH}" \
    "${EXTRACT_PATH}"
echo "Extract: ${EXTRACT_SIZE} bytes, pre-filtered: $(stat -c%s "${FILTERED_PATH}") bytes"

echo "Enabling PostGIS extension (no-op if already enabled)"
psql "${POSTGIS_URL}" -c "CREATE EXTENSION IF NOT EXISTS postgis;"

echo "Dropping any existing pois table"
psql "${POSTGIS_URL}" -c "DROP TABLE IF EXISTS pois;"

# No --slim, so node locations live in an in-memory store that grows as
# needed - osm2pgsql's --cache only applies in slim mode, which is why it
# isn't passed. --number-processes only parallelises the index build at the
# end (stage 2 is slim-only too); the read + Lua stage stays on one core
# whatever it's set to, which is what the osmium step above works around.
echo "Importing via osm2pgsql (flex output, import_pois.lua)"
osm2pgsql \
    --output=flex \
    --style=/import/import_pois.lua \
    --extra-attributes \
    --number-processes="${OSM2PGSQL_NUMBER_PROCESSES:-$(nproc)}" \
    -d "${POSTGIS_URL}" \
    "${FILTERED_PATH}"

echo "Creating indexes"
psql "${POSTGIS_URL}" -c "CREATE INDEX IF NOT EXISTS pois_geom_gist ON pois USING GIST (geom);"
psql "${POSTGIS_URL}" -c "CREATE INDEX IF NOT EXISTS pois_poi_type_idx ON pois (poi_type);"

ROW_COUNT=$(psql "${POSTGIS_URL}" -tAc "SELECT count(*) FROM pois;")
echo "Import complete: ${ROW_COUNT} rows"

rm -f "${EXTRACT_PATH}" "${FILTERED_PATH}"

# Consumed by update_check.sh (run on the host, outside any container) to
# decide when a reimport is worth doing - written last, after a successful
# import, so a failed run never records a false "up to date" state.
mkdir -p "$(dirname "${IMPORT_STATE_FILE:-/data/state/.last_import_state}")"
{
    echo "url=${OSM_EXTRACT_URL}"
    echo "size_bytes=${EXTRACT_SIZE}"
    echo "imported_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "${IMPORT_STATE_FILE:-/data/state/.last_import_state}"
