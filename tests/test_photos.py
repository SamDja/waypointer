"""Photos of an OSM element (photos.py). The fixtures are real answers from
Commons, Panoramax and Wikidata (checked 2026-09-26) - see conftest.py."""

from urllib.parse import parse_qs, urlparse

import pytest
import responses

from waypointer.photos import (
    COMMONS_API_URL,
    MAX_CATEGORY_FILES,
    MAX_REFS,
    PANORAMAX_API_URL,
    WIKIDATA_API_URL,
    PhotoRef,
    photo_refs,
    resolve_photos,
)

PANORAMAX_ID = "6d041a8f-bfa6-43bc-9a06-7440b853fbaf"


def _commons_page(title: str, taken: str = "2019-07-01 10:00:00", mediatype: str = "BITMAP") -> dict:
    return {
        "title": title,
        "imageinfo": [
            {
                "mediatype": mediatype,
                "timestamp": "2024-01-01T00:00:00Z",
                "thumburl": "https://thumb.wikimedia.org/x/640px-a.jpg",
                "url": f"https://upload.wikimedia.org/wikipedia/commons/a/ab/{title[5:]}",
                "descriptionurl": f"https://commons.wikimedia.org/wiki/{title}",
                "extmetadata": {
                    "DateTimeOriginal": {"value": taken},
                    "Artist": {"value": '<a href="//commons.wikimedia.org/wiki/User:X">X &amp; Y</a>'},
                    "LicenseShortName": {"value": "CC BY 4.0"},
                },
            }
        ],
    }


def _commons_file_json(title: str, taken: str = "2019-07-01 10:00:00") -> dict:
    return {"query": {"pages": [_commons_page(title, taken)]}}


def test_refs_split_values_and_read_numbered_keys_in_order():
    refs = photo_refs(
        {
            "panoramax:1": "11111111-1111-1111-1111-111111111111",
            "panoramax": f"{PANORAMAX_ID};22222222-2222-2222-2222-222222222222",
            "mapillary": "123456",
            "name": "Rifugio",
        }
    )
    assert refs == [
        PhotoRef("mapillary", "123456"),
        PhotoRef("panoramax", PANORAMAX_ID),
        PhotoRef("panoramax", "22222222-2222-2222-2222-222222222222"),
        PhotoRef("panoramax", "11111111-1111-1111-1111-111111111111"),
    ]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://commons.wikimedia.org/wiki/File:Lago_di_Tovel.jpg", PhotoRef("commons_file", "File:Lago_di_Tovel.jpg")),
        (
            "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/A%20b.jpg/960px-A%20b.jpg",
            PhotoRef("commons_file", "File:A b.jpg"),
        ),
        ("https://upload.wikimedia.org/wikipedia/commons/5/5d/A.jpg", PhotoRef("commons_file", "File:A.jpg")),
        ("File:A.jpg", PhotoRef("commons_file", "File:A.jpg")),
        ("https://example.org/hut.JPG", PhotoRef("image_url", "https://example.org/hut.JPG")),
        # Mixed content on an https page - linked, not shown.
        ("http://example.org/hut.jpg", PhotoRef("link", "http://example.org/hut.jpg")),
        ("https://www.flickr.com/photos/x/1", PhotoRef("link", "https://www.flickr.com/photos/x/1")),
        ("javascript:alert(1)", None),
        ("hut.jpg", None),
    ],
)
def test_image_tag_values(value, expected):
    assert photo_refs({"image": value}) == ([expected] if expected else [])


@pytest.mark.parametrize(
    "tags",
    [
        {"panoramax": "not-a-uuid"},
        {"mapillary": "12ab"},
        {"wikidata": "Q12;drop table"},
        {"wikimedia_commons": "Lago.jpg"},
        {"image:source": "https://example.org/a.jpg"},
    ],
)
def test_malformed_values_are_dropped(tags):
    refs = photo_refs(tags)
    assert all(r.kind == "wikidata" and r.value == "Q12" for r in refs)


def test_wikidata_is_only_followed_without_a_commons_ref():
    assert photo_refs({"wikidata": "Q1"}) == [PhotoRef("wikidata", "Q1")]
    assert photo_refs({"wikidata": "Q1", "wikimedia_commons": "Category:X"}) == [
        PhotoRef("commons_category", "Category:X")
    ]


def test_refs_are_capped():
    ids = ";".join(str(i) for i in range(MAX_REFS + 5))
    assert len(photo_refs({"mapillary": ids})) == MAX_REFS


@responses.activate
def test_commons_category_photos_with_author_and_licence(commons_category_json):
    responses.add(responses.GET, COMMONS_API_URL, json=commons_category_json, status=200)
    result = resolve_photos({"wikimedia_commons": "Category:Rifugio_Tonini"}, use_cache=False)

    assert len(result.photos) == 2
    # Newest first: file 02 was taken a minute and a half after file 01.
    assert [p.taken_at for p in result.photos] == ["2020-06-21T12:41:47Z", "2020-06-21T12:40:07Z"]
    photo = result.photos[1]
    assert photo.source == "commons"
    assert photo.author == "Syrio"
    assert photo.license == "CC BY-SA 4.0"
    assert photo.page_url.startswith("https://commons.wikimedia.org/wiki/File:")
    query = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert query["gcmtitle"] == ["Category:Rifugio_Tonini"]
    assert "User-Agent" in responses.calls[0].request.headers


@responses.activate
def test_commons_file_strips_html_from_the_author():
    responses.add(responses.GET, COMMONS_API_URL, json=_commons_file_json("File:Lago di Tovel.jpg"), status=200)
    result = resolve_photos({"wikimedia_commons": "File:Lago_di_Tovel.jpg"}, use_cache=False)
    assert [p.author for p in result.photos] == ["X & Y"]
    assert result.photos[0].taken_at == "2019-07-01T10:00:00Z"


@responses.activate
def test_only_photos_are_kept_from_a_commons_category():
    # The kinds of file a sample of real categories referenced from OSM held
    # besides photos (checked 2026-09-26): an Ogg audio clip, a PDF and a
    # DjVu scan (both with a rendered page as their thumbnail), a coat of
    # arms as SVG.
    pages = [
        _commons_page("File:Arena.jpg"),
        _commons_page("File:De-Konstantinsbogen.ogg", mediatype="AUDIO"),
        _commons_page("File:Proprium.pdf", mediatype="OFFICE"),
        _commons_page("File:Carli 1785.djvu", mediatype="OFFICE"),
        _commons_page("File:Arcumeggia-Stemma.svg", mediatype="DRAWING"),
        _commons_page("File:Tour.webm", mediatype="VIDEO"),
    ]
    responses.add(responses.GET, COMMONS_API_URL, json={"query": {"pages": pages}}, status=200)
    result = resolve_photos({"wikimedia_commons": "Category:Arena (Verona)"}, use_cache=False)

    assert [p.page_url for p in result.photos] == ["https://commons.wikimedia.org/wiki/File:Arena.jpg"]
    query = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert "mediatype" in query["iiprop"][0].split("|")


@responses.activate
def test_a_category_is_capped_after_dropping_what_isnt_a_photo():
    pages = [_commons_page(f"File:Doc {i}.pdf", mediatype="OFFICE") for i in range(5)]
    pages += [_commons_page(f"File:Photo {i}.jpg") for i in range(MAX_CATEGORY_FILES + 3)]
    responses.add(responses.GET, COMMONS_API_URL, json={"query": {"pages": pages}}, status=200)
    result = resolve_photos({"wikimedia_commons": "Category:X"}, use_cache=False)
    assert len(result.photos) == MAX_CATEGORY_FILES


@responses.activate
def test_a_commons_file_that_isnt_a_photo_is_dropped():
    responses.add(
        responses.GET,
        COMMONS_API_URL,
        json={"query": {"pages": [_commons_page("File:Map.pdf", mediatype="OFFICE")]}},
        status=200,
    )
    result = resolve_photos({"wikimedia_commons": "File:Map.pdf"}, use_cache=False)
    assert result.photos == [] and result.failed_sources == []


@responses.activate
def test_a_missing_commons_file_is_not_a_failure():
    responses.add(
        responses.GET, COMMONS_API_URL, json={"query": {"pages": [{"title": "File:Gone.jpg", "missing": True}]}}
    )
    result = resolve_photos({"wikimedia_commons": "File:Gone.jpg"}, use_cache=False)
    assert result.photos == [] and result.failed_sources == []


@responses.activate
def test_panoramax_photo(panoramax_json):
    responses.add(responses.GET, PANORAMAX_API_URL, json=panoramax_json, status=200)
    result = resolve_photos({"panoramax": PANORAMAX_ID}, use_cache=False)

    [photo] = result.photos
    assert photo.source == "panoramax"
    assert photo.thumb_url.endswith("/thumb.jpg")
    assert photo.taken_at == "2025-11-29T09:23:35Z"
    # The person, not the instance that hosts the picture.
    assert photo.author == "Robot8A"
    assert photo.license == "CC-BY-SA-4.0"
    assert PANORAMAX_ID in photo.page_url


@responses.activate
def test_wikidata_image_is_resolved_on_commons(wikidata_p18_json):
    responses.add(responses.GET, WIKIDATA_API_URL, json=wikidata_p18_json, status=200)
    responses.add(
        responses.GET, COMMONS_API_URL, json=_commons_file_json("File:Paganella Brenta Trento.jpg"), status=200
    )
    result = resolve_photos({"wikidata": "Q3376"}, use_cache=False)

    assert [p.page_url for p in result.photos] == [
        "https://commons.wikimedia.org/wiki/File:Paganella Brenta Trento.jpg"
    ]
    # Every P18 statement, in one Commons call.
    titles = parse_qs(urlparse(responses.calls[1].request.url).query)["titles"]
    assert titles == ["File:Paganella Brenta Trento.jpg|File:Trento visione d'insieme 6.jpg"]


@responses.activate
def test_mapillary_with_a_token():
    responses.add(
        responses.GET,
        "https://graph.mapillary.com/123456",
        json={
            "id": "123456",
            "thumb_1024_url": "https://scontent.example/t.jpg",
            "captured_at": 1_600_000_000_000,
            "creator": {"username": "rider"},
        },
        status=200,
    )
    result = resolve_photos({"mapillary": "123456"}, mapillary_token="secret", use_cache=False)

    [photo] = result.photos
    assert photo.taken_at == "2020-09-13T12:26:40Z"
    assert photo.author == "rider"
    assert parse_qs(urlparse(responses.calls[0].request.url).query)["access_token"] == ["secret"]


@responses.activate
def test_mapillary_without_a_token_is_a_link():
    result = resolve_photos({"mapillary": "123456"}, mapillary_token="", use_cache=False)
    assert result.photos == []
    assert [link.url for link in result.links] == ["https://www.mapillary.com/app/?pKey=123456&focus=photo"]
    assert len(responses.calls) == 0


@responses.activate
def test_newest_first_undated_last(panoramax_json):
    responses.add(responses.GET, PANORAMAX_API_URL, json=panoramax_json, status=200)
    responses.add(responses.GET, COMMONS_API_URL, json=_commons_file_json("File:Old.jpg", "2010-05-01"), status=200)
    result = resolve_photos(
        {"panoramax": PANORAMAX_ID, "wikimedia_commons": "File:Old.jpg", "image": "https://example.org/a.jpg"},
        use_cache=False,
    )
    assert [p.source for p in result.photos] == ["panoramax", "commons", "web"]


@responses.activate
def test_one_failing_service_leaves_the_others(panoramax_json):
    responses.add(responses.GET, PANORAMAX_API_URL, json=panoramax_json, status=200)
    responses.add(responses.GET, COMMONS_API_URL, body="down", status=503)
    result = resolve_photos({"panoramax": PANORAMAX_ID, "wikimedia_commons": "File:A.jpg"}, use_cache=False)

    assert [p.source for p in result.photos] == ["panoramax"]
    assert result.failed_sources == ["commons"]


@responses.activate
def test_urls_from_tags_are_never_fetched():
    # responses raises for any request that isn't registered, so reaching
    # the assertion means nothing was requested at all.
    result = resolve_photos(
        {"image": "https://169.254.169.254/latest/meta-data.jpg;http://localhost/admin"}, use_cache=False
    )
    assert [p.thumb_url for p in result.photos] == ["https://169.254.169.254/latest/meta-data.jpg"]
    assert [link.url for link in result.links] == ["http://localhost/admin"]
    assert len(responses.calls) == 0


@responses.activate
def test_answers_are_cached(panoramax_json):
    responses.add(responses.GET, PANORAMAX_API_URL, json=panoramax_json, status=200)
    resolve_photos({"panoramax": PANORAMAX_ID})
    again = resolve_photos({"panoramax": PANORAMAX_ID})
    assert len(again.photos) == 1
    assert len(responses.calls) == 1
