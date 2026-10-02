"""POST /api/nl-routes/generate (nl_routes.py): the feature gate, the three
kinds of answer, and how upstream failures map to responses. The LLM parse,
geocoding, BRouter and the POI database are all replaced; the route pipeline
in between is the real one (see test_route_candidates.py for its details)."""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from test_route_candidates import MOUNTAIN, START, FakeRouter, _constraints, _parsed, _resolved
from waypointer import llm, poi_db, route_request, routing, sessions
from waypointer.main import app
from waypointer.route_request import Question

ORIGIN = {"Origin": "http://testserver"}


def _user(features=("llm",)):
    return sessions.User(
        id="u1", email="a@b.co", email_verified=True, features=features, created_at=datetime.now(timezone.utc)
    )


@pytest.fixture
def client(monkeypatch):
    app.dependency_overrides[sessions.require_verified_user] = lambda: _user()
    # The parse: whatever the test sets as `parsed`, resolved to `constraints`.
    state = {"parsed": _parsed(), "constraints": None}
    monkeypatch.setattr(route_request, "parse_request", lambda text: (state["parsed"], None))
    monkeypatch.setattr(route_request, "resolve", lambda parsed, near, speed: state["constraints"])
    router = FakeRouter()
    monkeypatch.setattr(routing, "route_via", lambda points, profile, options, alternative=0: router(points, profile, options, alternative))
    monkeypatch.setattr(poi_db, "query_pois_near_route", lambda poi_type, coords, radius: [])
    monkeypatch.setattr(poi_db, "query_pois_near_point", lambda *args: [])

    def no_llm(*args, **kwargs):
        raise llm.LlmError("no model in tests")

    monkeypatch.setattr(llm, "complete_json", no_llm)
    test_client = TestClient(app)
    test_client.state = state  # type: ignore[attr-defined]
    test_client.router = router  # type: ignore[attr-defined]
    yield test_client
    app.dependency_overrides.clear()


def _post(client, text="giro di 80 km da Borgo col Manghen"):
    return client.post("/api/nl-routes/generate", data={"text": text, "lat": 46.05, "lon": 11.45}, headers=ORIGIN)


def test_needs_the_llm_feature(client):
    app.dependency_overrides[sessions.require_verified_user] = lambda: _user(features=())
    assert _post(client).status_code == 403


def test_refuses_another_origin(client):
    response = client.post("/api/nl-routes/generate", data={"text": "a loop"}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403


def test_answers_with_questions_before_routing(client):
    client.state["constraints"] = _constraints(
        start=None, questions=[Question(kind="missing", field="start", detail=None, options=[])]
    )
    body = _post(client).json()
    assert body["status"] == "questions"
    assert body["questions"][0]["field"] == "start"
    assert client.router.calls == []


def test_answers_with_what_to_ask_for_instead(client):
    parsed = _parsed(distance_km={"min": 20, "max": 30}, ascent_m={"min": 2000, "max": None})
    client.state["constraints"] = _constraints(parsed)
    body = _post(client).json()
    assert body["status"] == "infeasible"
    assert body["infeasible"]["reason"] == "ascent_per_km"
    assert body["infeasible"]["suggested_distance_km"]["min"] == 58


def test_returns_ranked_explained_options(client):
    parsed = _parsed(distance_km={"min": 50, "max": 90}, climbs={"categories": [], "named": ["Passo Manghen"]})
    client.state["constraints"] = _constraints(parsed, climbs=[_resolved("Passo Manghen", MOUNTAIN)])
    response = _post(client)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "options" and body["language"] == "it"
    assert 1 <= len(body["options"]) <= 3
    best = body["options"][0]
    assert best["metrics"]["named_climbs_passed"] == ["Passo Manghen"]
    assert best["points"][0] == list(START)
    assert len(best["coords"]) == len(best["elevations"]) >= 2
    # The LLM is down in these tests: the template explains instead.
    assert best["explanation"].startswith(f"{best['metrics']['distance_km']:.0f} km with")
    assert len(client.router.calls) <= 10


def test_passes_brouter_throttling_on(client):
    client.state["constraints"] = _constraints()
    client.router.rate_limit = True
    response = _post(client)
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "30"


def test_a_parser_failure_is_a_502(client, monkeypatch):
    def broken(text):
        raise llm.LlmError("down")

    monkeypatch.setattr(route_request, "parse_request", broken)
    assert _post(client).status_code == 502


def test_an_unconfigured_parser_is_a_503(client, monkeypatch):
    def unconfigured(text):
        raise llm.LlmNotConfiguredError("no key")

    monkeypatch.setattr(route_request, "parse_request", unconfigured)
    assert _post(client).status_code == 503
