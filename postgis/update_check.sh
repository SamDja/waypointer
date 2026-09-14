#!/usr/bin/env bash
# Meant to be run via a Pi-side cron entry (not baked into any container -
# see CLAUDE.md's "PostGIS POI database" section). Compares the current
# OSM_EXTRACT_URL extract's size against the size recorded at the last
# import (postgis/state/.last_import_state, gitignored, written by
# import.sh at the end of a successful run) and only triggers a reimport
# once both OSM_UPDATE_MIN_DAYS has elapsed *and* the size delta exceeds
# OSM_UPDATE_SIZE_PCT - a deliberately coarse proxy for "how much changed",
# same reasoning the shelved self-hosted-Overpass attempt used (see git
# history on infra/overpass) since there's no cheap way to know the real
# diff size without downloading and diffing the whole extract.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
STATE_FILE="${SCRIPT_DIR}/state/.last_import_state"

: "${OSM_EXTRACT_URL:?OSM_EXTRACT_URL must be set (see .env)}"
OSM_UPDATE_MIN_DAYS="${OSM_UPDATE_MIN_DAYS:-7}"
OSM_UPDATE_SIZE_PCT="${OSM_UPDATE_SIZE_PCT:-2}"

run_import() {
    ( cd "${REPO_DIR}" && docker compose run --rm poi-import )
}

if [[ ! -f "${STATE_FILE}" ]]; then
    echo "No previous import recorded (${STATE_FILE} missing) - running first import."
    run_import
    exit 0
fi

# shellcheck disable=SC1090
source "${STATE_FILE}"

imported_at_epoch=$(date -u -d "${imported_at}" +%s)
now_epoch=$(date -u +%s)
days_elapsed=$(( (now_epoch - imported_at_epoch) / 86400 ))
if (( days_elapsed < OSM_UPDATE_MIN_DAYS )); then
    echo "Only ${days_elapsed}d since last import (< ${OSM_UPDATE_MIN_DAYS}d) - skipping."
    exit 0
fi

current_size=$(curl -sIL "${OSM_EXTRACT_URL}" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-length"{print $2}' | tail -n1)
if [[ -z "${current_size}" ]]; then
    echo "Could not determine current extract size via a HEAD request - skipping."
    exit 0
fi

if (( current_size > size_bytes )); then
    delta_pct=$(( 100 * (current_size - size_bytes) / size_bytes ))
else
    delta_pct=$(( 100 * (size_bytes - current_size) / size_bytes ))
fi

if (( delta_pct < OSM_UPDATE_SIZE_PCT )); then
    echo "Extract size changed ${delta_pct}% (< ${OSM_UPDATE_SIZE_PCT}%) after ${days_elapsed}d - skipping reimport."
    exit 0
fi

echo "Extract size changed ${delta_pct}% after ${days_elapsed}d - reimporting."
run_import
