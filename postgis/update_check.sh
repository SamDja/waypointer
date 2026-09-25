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

# cron runs with a near-empty environment (no shell profile is sourced), so
# OSM_EXTRACT_URL/etc. must come from the repo's own .env - `docker compose`
# reads that file automatically when it runs, but this script's own gating
# logic below needs it too, before docker compose ever gets invoked.
if [[ -f "${REPO_DIR}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${REPO_DIR}/.env"
    set +a
fi

: "${OSM_EXTRACT_URL:?OSM_EXTRACT_URL must be set (see .env)}"
OSM_UPDATE_MIN_DAYS="${OSM_UPDATE_MIN_DAYS:-7}"
OSM_UPDATE_SIZE_PCT="${OSM_UPDATE_SIZE_PCT:-2}"

run_import() {
    ( cd "${REPO_DIR}" && docker compose run --rm poi-import )
}

# GNU date (Pi/Linux, the actual deployment target) parses an ISO 8601
# string with `-d`; BSD date (macOS, for local testing before deploying)
# needs `-j -f` with an explicit format instead. Falls back rather than
# picking one, so this script works in both places without extra deps.
_epoch_from_iso() {
    date -u -d "$1" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s
}

if [[ ! -f "${STATE_FILE}" ]]; then
    echo "No previous import recorded (${STATE_FILE} missing) - running first import."
    run_import
    exit 0
fi

# shellcheck disable=SC1090
source "${STATE_FILE}"

imported_at_epoch=$(_epoch_from_iso "${imported_at}")
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

echo "${now_epoch} - Extract size changed ${delta_pct}% (${size_bytes}/${current_size}) after ${days_elapsed}d - reimporting."
run_import
