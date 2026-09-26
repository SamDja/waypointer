"""Photos of an OSM element, for its map popup (/api/poi-photos).

OSM links photos from tags rather than holding them: `wikimedia_commons`
(a `File:` or `Category:` on Commons), `image` (usually a URL, often a
Commons one), `panoramax` (a Panoramax picture id), `mapillary` (a Mapillary
image id) and, indirectly, `wikidata` (whose P18 statement names a Commons
file). Each key may also appear numbered (`panoramax:1`), and any value may
hold several `;`-separated entries.

Structured like geocode.py - an "external HTTP dependency with a cache":
fixed service URLs, a shared TTLCache, the shared User-Agent, a timeout on
every call.

SSRF guard: the tags come from the request, so nothing here ever fetches a
URL found in them. Only the four services below are called, and only with
ids that have been checked against their expected shape. An `image` URL
that isn't on Commons is handed to the browser as-is (to display, or just to
link), never requested by the server.
"""

import html
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import unquote, urlparse

import requests

from waypointer.routing import USER_AGENT
from waypointer.ttl_cache import TTLCache

COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php"
WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php"
# The federated meta-catalogue: it indexes every Panoramax instance, so an id
# resolves here whichever instance the picture was uploaded to.
PANORAMAX_API_URL = "https://api.panoramax.xyz/api/search"
PANORAMAX_VIEWER_URL = "https://api.panoramax.xyz/#focus=pic&pic={id}"
MAPILLARY_API_URL = "https://graph.mapillary.com/{id}"
MAPILLARY_VIEWER_URL = "https://www.mapillary.com/app/?pKey={id}&focus=photo"
# Mapillary's API needs a client token (free, from a Mapillary developer
# app); without one a Mapillary photo is offered as a link instead.
MAPILLARY_TOKEN = os.environ.get("MAPILLARY_TOKEN", "")

# Mapillary's thumbnail URLs are signed and expire, so nothing is kept longer
# than an hour.
CACHE_TTL_S = 3600.0
TIMEOUT_S = 10
# A POI with more photo references than this is shown the first ones only.
MAX_REFS = 20
# Photos taken from one Commons category - a category can hold hundreds.
MAX_CATEGORY_FILES = 10
# Category members asked for, more than MAX_CATEGORY_FILES since the ones
# that aren't photos (see _commons_photo) are dropped afterwards.
CATEGORY_MEMBERS_FETCHED = 20
THUMB_WIDTH_PX = 640
MAX_AUTHOR_LENGTH = 100

PHOTO_TAG_KEY = re.compile(r"^(image|wikimedia_commons|panoramax|mapillary|wikidata)(?::\d+)?$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_MAPILLARY_ID = re.compile(r"^\d{1,20}$")
_WIKIDATA_ID = re.compile(r"^Q\d{1,12}$")
_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".gif")
_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?")

RefKind = Literal["commons_file", "commons_category", "wikidata", "panoramax", "mapillary", "image_url", "link"]
# What failed_sources names, and what a Photo says it came from.
Source = Literal["commons", "wikidata", "panoramax", "mapillary", "web"]


class PhotoError(RuntimeError):
    """One photo service failed or answered with something unusable."""


@dataclass(frozen=True)
class PhotoRef:
    kind: RefKind
    value: str


@dataclass(frozen=True)
class Photo:
    source: Source
    thumb_url: str
    full_url: str
    # Where the photo lives with its licence and history - what "open" opens.
    page_url: str
    # ISO 8601 in UTC ("2025-11-29T09:23:35Z"), None when the service gives
    # no date. When the photo was taken where known, else when uploaded.
    taken_at: str | None = None
    author: str | None = None
    license: str | None = None


@dataclass(frozen=True)
class PhotoLink:
    """A photo the app can point at but not show."""

    source: Source
    url: str


@dataclass
class PhotoResult:
    photos: list[Photo] = field(default_factory=list)
    links: list[PhotoLink] = field(default_factory=list)
    failed_sources: list[Source] = field(default_factory=list)


_cache: TTLCache[list[Photo]] = TTLCache(CACHE_TTL_S)


def _commons_file_from_url(url: str) -> str | None:
    """`File:Name.jpg` for a Commons page or upload.wikimedia.org URL."""
    parsed = urlparse(url)
    host = parsed.hostname or ""
    path = unquote(parsed.path)
    if host == "commons.wikimedia.org" and path.startswith("/wiki/File:"):
        return path.removeprefix("/wiki/")
    if host == "upload.wikimedia.org":
        parts = [p for p in path.split("/") if p]
        # /wikipedia/commons/5/5d/Name.jpg, or the thumbnail form
        # /wikipedia/commons/thumb/5/5d/Name.jpg/960px-Name.jpg.
        if len(parts) >= 5 and parts[:2] == ["wikipedia", "commons"]:
            name = parts[5] if parts[2] == "thumb" and len(parts) >= 6 else parts[4]
            return f"File:{name}"
    return None


def _image_ref(value: str) -> PhotoRef | None:
    if value.lower().startswith("file:"):
        return PhotoRef("commons_file", "File:" + value[5:].strip())
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    commons_file = _commons_file_from_url(value)
    if commons_file:
        return PhotoRef("commons_file", commons_file)
    # An https image is shown straight from its host by the browser. A plain
    # http one would be blocked as mixed content, so it's only linked.
    if parsed.scheme == "https" and parsed.path.lower().endswith(_IMAGE_EXTENSIONS):
        return PhotoRef("image_url", value)
    return PhotoRef("link", value)


def _ref(key: str, value: str) -> PhotoRef | None:
    if key == "image":
        return _image_ref(value)
    if key == "wikimedia_commons":
        prefix, _, name = value.partition(":")
        if prefix.lower() == "file" and name.strip():
            return PhotoRef("commons_file", f"File:{name.strip()}")
        if prefix.lower() == "category" and name.strip():
            return PhotoRef("commons_category", f"Category:{name.strip()}")
        return None
    if key == "panoramax" and _UUID.match(value):
        return PhotoRef("panoramax", value.lower())
    if key == "mapillary" and _MAPILLARY_ID.match(value):
        return PhotoRef("mapillary", value)
    if key == "wikidata" and _WIKIDATA_ID.match(value):
        return PhotoRef("wikidata", value)
    return None


def photo_refs(tags: dict[str, str]) -> list[PhotoRef]:
    """Every photo reference in an element's tags, de-duplicated, at most
    MAX_REFS. Values that don't have the shape their key promises are
    dropped rather than guessed at.

    `wikidata` is only followed when nothing else points at Commons: its
    P18 image is the item's one representative photo, usually a copy of
    what `wikimedia_commons`/`image` already name.
    """
    refs: list[PhotoRef] = []
    for key in sorted(tags, key=_key_order):
        match = PHOTO_TAG_KEY.match(key)
        if not match:
            continue
        for value in tags[key].split(";"):
            ref = _ref(match.group(1), value.strip())
            if ref and ref not in refs:
                refs.append(ref)
    if any(r.kind in ("commons_file", "commons_category") for r in refs):
        refs = [r for r in refs if r.kind != "wikidata"]
    return refs[:MAX_REFS]


def _key_order(key: str) -> tuple[str, int]:
    """`image` before `image:1` before `image:2`, so numbered keys keep the
    order the mapper gave them."""
    base, _, number = key.partition(":")
    return (base, int(number) if number.isdigit() else -1)


def _iso_utc(moment: datetime) -> str:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_date(text: str | None) -> str | None:
    """A date from a free-form string, as _iso_utc. Commons' DateTimeOriginal
    is whatever the uploader wrote - "2020-06-21 12:40:07", a bare date, or
    HTML around one - so this looks for the first date in it."""
    if not text:
        return None
    match = _DATE.search(text)
    if not match:
        return None
    try:
        parts = [int(p) if p else 0 for p in match.groups()]
        return _iso_utc(datetime(*parts))  # type: ignore[misc]
    except ValueError:
        return None


def _plain_text(value: str | None) -> str | None:
    if not value:
        return None
    text = html.unescape(re.sub(r"<[^>]+>", "", value)).strip()
    return text[:MAX_AUTHOR_LENGTH] or None


def _get_json(http, url: str, params: dict | None, source: Source) -> dict:
    try:
        response = http.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT_S)
    except requests.RequestException as exc:
        raise PhotoError(f"{source} request failed: {exc}") from exc
    if response.status_code != 200:
        raise PhotoError(f"{source} returned status {response.status_code}")
    try:
        data = response.json()
    except ValueError as exc:
        raise PhotoError(f"{source} returned malformed data: {exc}") from exc
    if not isinstance(data, dict):
        raise PhotoError(f"{source} returned malformed data")
    return data


def _commons_photo(page: dict) -> Photo | None:
    """A Commons file as a Photo, or None if it isn't a photo. Commons also
    holds audio, video, PDFs and scanned books (which come with a rendered
    page as a thumbnail, so they'd pass for a photo), and SVG drawings -
    coats of arms, logos, maps - which aren't a picture of the place either.
    Only BITMAP (JPEG, PNG, WebP, TIFF, ...) is kept."""
    try:
        info = page["imageinfo"][0]
        if info.get("mediatype") != "BITMAP":
            return None
        thumb_url = info.get("thumburl") or info["url"]
        meta = info.get("extmetadata") or {}
        return Photo(
            source="commons",
            thumb_url=thumb_url,
            full_url=info["url"],
            page_url=info["descriptionurl"],
            taken_at=_parse_date(meta.get("DateTimeOriginal", {}).get("value")) or _parse_date(info.get("timestamp")),
            author=_plain_text(meta.get("Artist", {}).get("value")),
            license=_plain_text(meta.get("LicenseShortName", {}).get("value")),
        )
    except (KeyError, IndexError, TypeError):
        return None


_COMMONS_IMAGEINFO = {
    "action": "query",
    "format": "json",
    "formatversion": "2",
    "prop": "imageinfo",
    "iiprop": "url|extmetadata|timestamp|mediatype",
    "iiurlwidth": str(THUMB_WIDTH_PX),
    "iiextmetadatafilter": "DateTimeOriginal|Artist|LicenseShortName",
}


def _commons_pages(data: dict) -> list[dict]:
    pages = (data.get("query") or {}).get("pages") or []
    return [p for p in pages if isinstance(p, dict) and not p.get("missing")]


def _normalise_title(title: str) -> str:
    """Commons' own spelling of a title - underscores as spaces, first
    letter capitalised - so a file's answer can be matched to its ref."""
    prefix, _, name = title.replace("_", " ").partition(":")
    name = name.strip()
    return f"{prefix.capitalize()}:{name[:1].upper()}{name[1:]}"


def _resolve_commons_files(titles: list[str], http) -> dict[str, list[Photo]]:
    """Photos keyed by the (already normalised) file title. A file Commons doesn't
    have maps to an empty list rather than being an error - tags go stale."""
    found: dict[str, list[Photo]] = {t: [] for t in titles}
    # The API takes up to 50 titles per call; MAX_REFS keeps us well below.
    data = _get_json(http, COMMONS_API_URL, {**_COMMONS_IMAGEINFO, "titles": "|".join(titles)}, "commons")
    for page in _commons_pages(data):
        photo = _commons_photo(page)
        if photo:
            found[_normalise_title(page.get("title", ""))] = [photo]
    return found


def _resolve_commons_category(title: str, http) -> list[Photo]:
    params = {
        **_COMMONS_IMAGEINFO,
        "generator": "categorymembers",
        "gcmtitle": title,
        "gcmtype": "file",
        "gcmlimit": str(CATEGORY_MEMBERS_FETCHED),
    }
    data = _get_json(http, COMMONS_API_URL, params, "commons")
    return [photo for photo in (_commons_photo(p) for p in _commons_pages(data)) if photo][:MAX_CATEGORY_FILES]


def _wikidata_image_files(item: str, http) -> list[str]:
    params = {"action": "wbgetclaims", "format": "json", "entity": item, "property": "P18"}
    data = _get_json(http, WIKIDATA_API_URL, params, "wikidata")
    if "error" in data:
        # A deleted or merged item - nothing to show, not a failure.
        return []
    files = []
    for claim in (data.get("claims") or {}).get("P18") or []:
        try:
            value = claim["mainsnak"]["datavalue"]["value"]
        except (KeyError, TypeError):
            continue
        if isinstance(value, str) and value:
            files.append(f"File:{value}")
    return files


def _panoramax_photo(feature: dict) -> Photo | None:
    try:
        picture_id = feature["id"]
        assets = feature["assets"]
        thumb_url = (assets.get("thumb") or assets["sd"])["href"]
        full_url = (assets.get("sd") or assets.get("hd") or assets["thumb"])["href"]
        props = feature.get("properties") or {}
    except (KeyError, TypeError):
        return None
    # Providers list the instance (which has an id) and then the person.
    producers = [
        p.get("name") for p in feature.get("providers") or [] if "producer" in (p.get("roles") or []) and not p.get("id")
    ]
    taken_at = None
    if props.get("datetime"):
        try:
            taken_at = _iso_utc(datetime.fromisoformat(props["datetime"]))
        except ValueError:
            taken_at = _parse_date(props["datetime"])
    return Photo(
        source="panoramax",
        thumb_url=thumb_url,
        full_url=full_url,
        page_url=PANORAMAX_VIEWER_URL.format(id=picture_id),
        taken_at=taken_at,
        author=_plain_text(producers[-1]) if producers else None,
        license=props.get("license"),
    )


def _resolve_panoramax(ids: list[str], http) -> dict[str, list[Photo]]:
    data = _get_json(http, PANORAMAX_API_URL, {"ids": ",".join(ids), "limit": str(len(ids))}, "panoramax")
    found: dict[str, list[Photo]] = {i: [] for i in ids}
    for feature in data.get("features") or []:
        photo = _panoramax_photo(feature) if isinstance(feature, dict) else None
        if photo and str(feature["id"]).lower() in found:
            found[str(feature["id"]).lower()] = [photo]
    return found


def _resolve_mapillary(image_id: str, token: str, http) -> list[Photo]:
    params = {"fields": "thumb_1024_url,thumb_original_url,captured_at,creator", "access_token": token}
    data = _get_json(http, MAPILLARY_API_URL.format(id=image_id), params, "mapillary")
    thumb_url = data.get("thumb_1024_url")
    if not thumb_url:
        return []
    captured_at = data.get("captured_at")
    taken_at = (
        _iso_utc(datetime.fromtimestamp(captured_at / 1000, tz=timezone.utc))
        if isinstance(captured_at, (int, float))
        else None
    )
    creator = data.get("creator") if isinstance(data.get("creator"), dict) else {}
    return [
        Photo(
            source="mapillary",
            thumb_url=thumb_url,
            full_url=data.get("thumb_original_url") or thumb_url,
            page_url=MAPILLARY_VIEWER_URL.format(id=image_id),
            taken_at=taken_at,
            author=_plain_text(creator.get("username")),
            # Every image on Mapillary is published under this licence.
            license="CC BY-SA 4.0",
        )
    ]


def resolve_photos(
    tags: dict[str, str],
    session: requests.Session | None = None,
    mapillary_token: str | None = None,
    use_cache: bool = True,
) -> PhotoResult:
    """Every photo the element's tags point to, newest first, undated last.

    Never raises for a service failing: that service is named in
    failed_sources and the others still answer, since one photo host being
    down shouldn't hide the photos another one has.
    """
    http = session or requests
    token = MAPILLARY_TOKEN if mapillary_token is None else mapillary_token
    result = PhotoResult()
    refs = photo_refs(tags)

    def fail(source: Source) -> None:
        if source not in result.failed_sources:
            result.failed_sources.append(source)

    def batch(keys: list[str], prefix: str, fetch, source: Source) -> list[Photo]:
        """Photos for keys a service answers in one call, from the cache
        where it has them."""
        found = {k: _cache.get(f"{prefix}:{k}") if use_cache else None for k in keys}
        missing = [k for k, v in found.items() if v is None]
        if missing:
            try:
                fetched = fetch(missing)
            except PhotoError:
                fail(source)
                fetched = {}
            for k in missing:
                if k in fetched:
                    found[k] = fetched[k]
                    if use_cache:
                        _cache.set(f"{prefix}:{k}", fetched[k])
        return [p for photos in found.values() if photos for p in photos]

    def single(key: str, fetch, source: Source) -> list[Photo]:
        found = _cache.get(key) if use_cache else None
        if found is None:
            try:
                found = fetch()
            except PhotoError:
                fail(source)
                return []
            if use_cache:
                _cache.set(key, found)
        return found

    # Wikidata only ever names Commons files, so it's resolved first and its
    # files join the Commons batch.
    commons_files = [_normalise_title(r.value) for r in refs if r.kind == "commons_file"]
    for ref in (r for r in refs if r.kind == "wikidata"):
        files = _wikidata_files_cache.get(ref.value) if use_cache else None
        if files is None:
            try:
                files = _wikidata_image_files(ref.value, http)
            except PhotoError:
                fail("wikidata")
                continue
            if use_cache:
                _wikidata_files_cache.set(ref.value, files)
        commons_files += [_normalise_title(f) for f in files if _normalise_title(f) not in commons_files]

    photos = batch(commons_files, "commons", lambda titles: _resolve_commons_files(titles, http), "commons")
    for ref in (r for r in refs if r.kind == "commons_category"):
        photos += single(
            f"commons-category:{ref.value}", lambda v=ref.value: _resolve_commons_category(v, http), "commons"
        )
    photos += batch(
        [r.value for r in refs if r.kind == "panoramax"],
        "panoramax",
        lambda ids: _resolve_panoramax(ids, http),
        "panoramax",
    )
    for ref in (r for r in refs if r.kind == "mapillary"):
        if token:
            photos += single(
                f"mapillary:{ref.value}", lambda v=ref.value: _resolve_mapillary(v, token, http), "mapillary"
            )
        else:
            result.links.append(PhotoLink("mapillary", MAPILLARY_VIEWER_URL.format(id=ref.value)))

    for ref in refs:
        if ref.kind == "image_url":
            photos.append(Photo("web", ref.value, ref.value, ref.value))
        elif ref.kind == "link":
            result.links.append(PhotoLink("web", ref.value))

    # One file can be named twice (by `image` and `wikimedia_commons`).
    unique: dict[str, Photo] = {}
    for photo in photos:
        unique.setdefault(photo.full_url, photo)
    # Newest first; the ISO strings share one format, so they sort by time.
    result.photos = sorted(unique.values(), key=lambda p: p.taken_at or "", reverse=True)
    return result


# Wikidata item -> the Commons files its P18 names.
_wikidata_files_cache: TTLCache[list[str]] = TTLCache(CACHE_TTL_S)


def clear_caches() -> None:
    _cache.clear()
    _wikidata_files_cache.clear()
