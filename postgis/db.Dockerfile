# A minimal PostGIS-on-Postgres image, built ourselves rather than pulled
# from postgis/postgis: that image publishes amd64 only, no arm64 build for
# any tag - a hard blocker on the Raspberry Pi. `postgres` (this FROM) is a
# genuine multi-arch Docker Official Image (amd64/arm64/armv7), and this is
# exactly what postgis/postgis's own upstream source does under the hood
# (apt-installing PostGIS on top of the official postgres image) - their
# Docker Hub automation just never added arm64 to its build matrix.
#
# Only the plain `postgis` extension is installed - not
# postgis_topology/postgis_tiger_geocoder/address_standardizer, which the
# upstream postgis/postgis image bundles by default but this app never
# uses (no geocoding, no topology).
FROM postgres:16-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-16-postgis-3 \
    && rm -rf /var/lib/apt/lists/*

# Runs once, only against a freshly-initialized (empty) data directory -
# the standard postgres image entrypoint convention. import.sh's own
# `CREATE EXTENSION IF NOT EXISTS postgis` stays as a harmless defensive
# fallback for a data volume that predates this file.
COPY initdb/01-postgis.sql /docker-entrypoint-initdb.d/
