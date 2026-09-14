# Standalone image for the one-shot `poi-import` docker-compose service -
# bundles osm2pgsql + the Postgres client + curl, none of which the main
# `waypointer` image needs, so this stays a separate build rather than
# bloating the app image. Debian's own repos carry a recent-enough osm2pgsql
# package, avoiding a build-from-source step.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    osm2pgsql \
    postgresql-client \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /import
COPY import_pois.lua import.sh ./
RUN chmod +x import.sh

ENTRYPOINT ["./import.sh"]
