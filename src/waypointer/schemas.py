from pydantic import BaseModel


class Candidate(BaseModel):
    osm_id: int
    name: str | None = None
    lat: float
    lon: float
    distance_m: float


class FindFountainsResponse(BaseModel):
    candidates: list[Candidate]
    point_count: int
    existing_waypoint_count: int
    route_coords: list[tuple[float, float]]
