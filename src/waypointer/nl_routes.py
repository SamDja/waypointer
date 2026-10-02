"""POST /api/nl-routes/generate: plain words in, ranked routes out.

The endpoint over route_request.py (parse the words, geocode the places, list
what to ask) and route_candidates.py (plan, route, measure, rank, explain).
A test-phase feature: only accounts with "llm" in their features may call
it, since every request spends LLM tokens and about ten calls on BRouter's
shared public instance. Nothing in the frontend calls it yet.
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, Form, HTTPException

from waypointer import geocode, llm, route_candidates, route_request, routing
from waypointer.auth import load_settings
from waypointer.geometry import simplify_rdp
from waypointer.rate_limit import nl_route_rate_limit
from waypointer.schemas import (
    NlRouteClimb,
    NlRouteInfeasible,
    NlRouteMetrics,
    NlRouteMiss,
    NlRouteOption,
    NlRoutesResponse,
)
from waypointer.sessions import User, connection, require_feature, require_same_origin

logger = logging.getLogger(__name__)

router = APIRouter()

# The longest request text accepted - a route request is a sentence or two.
MAX_TEXT_LENGTH = 1000
# Simplification of each option's line for the map (as find_pois' route).
SIMPLIFY_TOLERANCE_M = 8.0
# Same back-off as the other upstream 429s (main.py).
UPSTREAM_RETRY_AFTER_S = 30


def _speeds(user: User) -> tuple[float, float]:
    """(average speed for turning a duration into a distance, VAM) from the
    account's settings, else the defaults."""
    try:
        with connection() as conn:
            settings = load_settings(conn, user.id)
    except Exception:  # noqa: BLE001 - settings are a nicety, never a failure
        logger.warning("couldn't load settings for route generation", exc_info=True)
        return route_request.DEFAULT_AVG_SPEED_KMH, route_candidates.DEFAULT_VAM_M_PER_H
    return (
        settings.avg_speed_kmh.get(route_candidates.ACTIVITY, route_request.DEFAULT_AVG_SPEED_KMH),
        settings.vam_m_per_h.get(route_candidates.ACTIVITY, route_candidates.DEFAULT_VAM_M_PER_H),
    )


def _option(scored: route_candidates.ScoredCandidate, explanation: str) -> NlRouteOption:
    candidate, m = scored.candidate, scored.metrics
    # Simplify, keeping each kept point's elevation alongside it.
    kept = set(simplify_rdp(candidate.coords, SIMPLIFY_TOLERANCE_M))
    pairs = [(c, e) for c, e in zip(candidate.coords, candidate.elevations) if c in kept]
    return NlRouteOption(
        id=candidate.plan.id,
        shape=candidate.plan.kind,
        points=list(candidate.plan.points),
        coords=[c for c, _ in pairs],
        elevations=[e for _, e in pairs],
        metrics=NlRouteMetrics(
            distance_km=m.distance_km,
            ascent_m=m.ascent_m,
            descent_m=m.descent_m,
            max_grade_pct=m.max_grade_pct,
            climbs=[NlRouteClimb(**vars(c)) for c in m.climbs],
            difficulty=m.difficulty,
            difficulty_reason=m.difficulty_reason,
            duration_h=m.duration_h,
            surface_share=m.surface_share,
            cycleway_share=m.cycleway_share,
            water_count=m.water_count,
            repeated_share=m.repeated_share,
            named_climbs_passed=m.named_climbs_passed,
        ),
        misses=[NlRouteMiss(constraint=x.constraint, wanted=x.wanted, got=x.got) for x in scored.misses],
        explanation=explanation,
    )


def _infeasible(verdict: route_candidates.Infeasible) -> NlRouteInfeasible:
    return NlRouteInfeasible(
        reason=verdict.reason,
        detail=verdict.detail,
        suggested_distance_km=verdict.suggested_distance_km.model_dump() if verdict.suggested_distance_km else None,
        suggested_ascent_m=verdict.suggested_ascent_m.model_dump() if verdict.suggested_ascent_m else None,
        suggested_climb_categories=verdict.suggested_climb_categories,
    )


@router.post(
    "/api/nl-routes/generate",
    response_model=NlRoutesResponse,
    dependencies=[Depends(require_same_origin), Depends(nl_route_rate_limit)],
)
async def generate_nl_routes(
    text: str = Form(..., min_length=3, max_length=MAX_TEXT_LENGTH),
    # The map's centre, to bias place names towards where the visitor looks.
    lat: float | None = Form(None, ge=-90, le=90),
    lon: float | None = Form(None, ge=-180, le=180),
    user: User = Depends(require_feature("llm")),
) -> NlRoutesResponse:
    try:
        parsed, _ = await asyncio.to_thread(route_request.parse_request, text)
    except llm.LlmNotConfiguredError as exc:
        logger.error("route parser not configured: %s", exc)
        raise HTTPException(503, "Route generation isn't set up on this server.") from exc
    except (llm.LlmError, route_request.ParseError) as exc:
        logger.warning("route request parse failed: %s", exc)
        raise HTTPException(502, "Couldn't read that request right now - please try again.") from exc

    avg_speed, vam = _speeds(user)
    near = (lat, lon) if lat is not None and lon is not None else None
    try:
        constraints = await asyncio.to_thread(route_request.resolve, parsed, near, avg_speed)
    except geocode.GeocodeRateLimitedError as exc:
        raise HTTPException(
            429,
            "Place search is busy - please wait a moment and try again.",
            headers={"Retry-After": str(UPSTREAM_RETRY_AFTER_S)},
        ) from exc
    except geocode.GeocodeError as exc:
        raise HTTPException(502, "Couldn't look up those places right now.") from exc

    language = parsed.language or "en"
    if constraints.questions:
        return NlRoutesResponse(
            status="questions",
            language=language,
            questions=[q.model_dump() for q in constraints.questions],
            infeasible=None,
            options=[],
        )

    try:
        outcome = await asyncio.to_thread(route_candidates.generate_routes, constraints, vam_m_per_h=vam)
    except routing.RoutingRateLimitedError as exc:
        raise HTTPException(
            429,
            "The routing service is busy - please wait a moment and try again.",
            headers={"Retry-After": str(UPSTREAM_RETRY_AFTER_S)},
        ) from exc
    except routing.RoutingError as exc:
        logger.warning("route generation failed: %s", exc)
        raise HTTPException(502, "Couldn't plan any route for that right now.") from exc

    logger.info("nl routes: %d candidates routed, %d returned", outcome.routed, len(outcome.options))
    if outcome.infeasible:
        return NlRoutesResponse(
            status="infeasible",
            language=language,
            questions=[],
            infeasible=_infeasible(outcome.infeasible),
            options=[],
        )
    return NlRoutesResponse(
        status="options",
        language=language,
        questions=[],
        infeasible=None,
        options=[_option(s, outcome.explanations.get(s.candidate.plan.id, "")) for s in outcome.options],
    )
