"""Place search (geocode.py). tests/fixtures/photon_response.json is a real
Photon response for "Trento" (checked 2026-09-22) - an area with an extent
and points without one."""

from urllib.parse import parse_qs, urlparse

import pytest
import responses

from waypointer.geocode import GEOCODE_URL, GeocodeError, search_places


@responses.activate
def test_parses_places_with_context_kind_and_bbox(photon_json):
    responses.add(responses.GET, GEOCODE_URL, json=photon_json, status=200)
    places = search_places("Trento", use_cache=False)

    trento = places[0]
    assert trento.name == "Trento"
    assert trento.kind == "city"
    # Local-language names, as Photon returns them without a lang parameter.
    assert "Provincia di Trento" in trento.context
    assert trento.lat == pytest.approx(46.07, abs=0.05)
    # Photon's extent is [west, north, east, south]; ours is [west, south, east, north].
    west, south, east, north = trento.bbox
    assert west < east and south < north


@responses.activate
def test_sends_the_place_filters_and_a_rounded_bias(photon_json):
    responses.add(responses.GET, GEOCODE_URL, json=photon_json, status=200)
    search_places("Trento", near=(46.0712, 11.1234), use_cache=False)

    query = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert query["osm_tag"] == ["place", "natural", "mountain_pass"]
    assert query["lat"] == ["46.1"] and query["lon"] == ["11.1"]
    assert "User-Agent" in responses.calls[0].request.headers


@responses.activate
def test_cache_is_keyed_on_query_and_rounded_bias(photon_json):
    responses.add(responses.GET, GEOCODE_URL, json=photon_json, status=200)
    search_places("Trento", near=(46.071, 11.12))
    search_places("trento ", near=(46.074, 11.13))  # same query, same ~10km bias cell
    search_places("Trento", near=(45.4, 11.0))  # elsewhere
    assert len(responses.calls) == 2


@pytest.mark.parametrize("query", ["", "ab", "  ab  ", "x" * 201])
def test_rejects_too_short_or_too_long_queries(query):
    with pytest.raises(ValueError):
        search_places(query, use_cache=False)


@responses.activate
def test_error_status_raises():
    responses.add(responses.GET, GEOCODE_URL, body="busy", status=503)
    with pytest.raises(GeocodeError):
        search_places("Trento", use_cache=False)


@responses.activate
def test_skips_features_it_cant_use(photon_json):
    photon_json["features"].append({"type": "Feature", "properties": {}, "geometry": None})
    responses.add(responses.GET, GEOCODE_URL, json=photon_json, status=200)
    assert all(place.name for place in search_places("Trento", use_cache=False))
