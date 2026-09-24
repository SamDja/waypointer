"""Cross-checks postgis/import_pois.lua's FILTERS against poi_types.py.

The two are hand-mirrored in different languages, and nothing enforced that
they agreed. The failure is silent and expensive: a searchable type whose
Lua filter is missing or narrower imports no rows, so the app finds nothing
for it and only says so after a full reimport on the Pi.

Both sides are parsed strictly - an entry that doesn't match the expected
shape fails the test rather than being skipped, so the parser can't quietly
stop checking the thing it exists to check.
"""

import re
from pathlib import Path

import pytest

from waypointer.poi_types import POI_TYPES

LUA_PATH = Path(__file__).parent.parent / "postgis" / "import_pois.lua"
PREFILTER_PATH = LUA_PATH.parent / "prefilter.txt"

# A condition is a tag key plus either the set of values it may take, or
# EXISTS for a bare-key match.
EXISTS = "<exists>"
Condition = tuple[str, frozenset[str] | str]
# scope ("any"/"node"/"way") plus the AND'd conditions, order-insensitive.
Filter = tuple[str, frozenset[Condition]]


def _parse_python(tag_filter: str) -> Filter:
    match = re.fullmatch(r"(nwr|node|way)((?:\[[^\]]*\])+)", tag_filter)
    assert match, f"unparseable tag_filter: {tag_filter}"
    scope = "any" if match.group(1) == "nwr" else match.group(1)

    conditions: set[Condition] = set()
    for clause in re.findall(r"\[([^\]]*)\]", match.group(2)):
        if exact := re.fullmatch(r'"([^"]+)"="([^"]+)"', clause):
            conditions.add((exact.group(1), frozenset({exact.group(2)})))
        elif alternation := re.fullmatch(r'"([^"]+)"~"\^\(([^)]+)\)\$"', clause):
            conditions.add((alternation.group(1), frozenset(alternation.group(2).split("|"))))
        elif bare := re.fullmatch(r'"([^"]+)"', clause):
            conditions.add((bare.group(1), EXISTS))
        else:
            pytest.fail(f"unparseable clause {clause!r} in {tag_filter}")
    return scope, frozenset(conditions)


_LUA_ENTRY = re.compile(
    r"^\s*(?P<key>\w+)\s*=\s*\{\s*scope\s*=\s*'(?P<scope>\w+)'\s*,\s*match\s*=\s*\{(?P<match>.+)\}\s*\}\s*,\s*$"
)
_LUA_CONDITION = re.compile(
    r"\{\s*key\s*=\s*'(?P<key>[^']+)'\s*,\s*"
    r"(?:value\s*=\s*'(?P<value>[^']+)'"
    r"|in_\s*=\s*\{(?P<in>[^}]*)\}"
    r"|exists\s*=\s*(?P<exists>true))\s*\}"
)


def _parse_lua() -> dict[str, Filter]:
    source = LUA_PATH.read_text()
    table = re.search(r"local FILTERS = \{\n(.*?)\n\}", source, re.DOTALL)
    assert table, "FILTERS table not found in import_pois.lua"

    filters: dict[str, Filter] = {}
    for line in table.group(1).splitlines():
        if not line.strip() or line.strip().startswith("--"):
            continue
        entry = _LUA_ENTRY.match(line)
        assert entry, f"unparseable FILTERS line: {line.strip()}"

        conditions: set[Condition] = set()
        remainder = entry.group("match")
        for condition in _LUA_CONDITION.finditer(remainder):
            remainder = remainder.replace(condition.group(0), "", 1)
            if condition.group("value") is not None:
                conditions.add((condition.group("key"), frozenset({condition.group("value")})))
            elif condition.group("in") is not None:
                values = re.findall(r"'([^']+)'", condition.group("in"))
                conditions.add((condition.group("key"), frozenset(values)))
            else:
                conditions.add((condition.group("key"), EXISTS))
        # Anything left over is a condition the parser didn't understand.
        assert not remainder.strip(" ,"), f"unparsed conditions in {entry.group('key')}: {remainder!r}"
        filters[entry.group("key")] = (entry.group("scope"), frozenset(conditions))
    return filters


def _searchable() -> dict[str, Filter]:
    return {
        key: _parse_python(config.tag_filter)
        for key, config in POI_TYPES.items()
        if config.tag_filter is not None
    }


def test_lua_covers_exactly_the_searchable_types():
    # A searchable type missing from the Lua imports no rows at all; a Lua
    # entry with no searchable type fills the table with rows nothing queries.
    assert set(_parse_lua()) == set(_searchable())


@pytest.mark.parametrize("poi_type", sorted(_searchable()))
def test_lua_filter_matches_its_python_tag_filter(poi_type: str):
    assert _parse_lua()[poi_type] == _searchable()[poi_type]


def test_parser_actually_parsed_the_table():
    # Guards the guard: a regex that silently matched nothing would make
    # every assertion above trivially true.
    assert len(_parse_lua()) > 25


def test_lodging_includes_both_kinds_of_mountain_hut():
    # The reason this test file exists: wilderness_hut was added to one side
    # and had to be added to the other two by hand.
    _, conditions = _searchable()["lodging"]
    values = dict(conditions)["tourism"]
    assert {"alpine_hut", "wilderness_hut"} <= values


# osmium's object-type letters, per Lua scope a FILTERS entry can have.
_SCOPE_TYPES = {"any": set("nwr"), "node": {"n"}, "way": {"w"}}
# One prefilter.txt line: object types, key, and its values or EXISTS.
PrefilterLine = tuple[set[str], str, frozenset[str] | str]


def _parse_prefilter() -> list[PrefilterLine]:
    lines: list[PrefilterLine] = []
    for raw in PREFILTER_PATH.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([nwr]+)/([\w:]+)(?:=([\w,]+))?", line)
        assert match, f"unparseable prefilter.txt line: {line}"
        values = frozenset(match.group(3).split(",")) if match.group(3) else EXISTS
        lines.append((set(match.group(1)), match.group(2), values))
    return lines


def _covers(line: PrefilterLine, scope: str, condition: Condition) -> bool:
    types, key, values = line
    cond_key, cond_values = condition
    if key != cond_key or not _SCOPE_TYPES[scope] <= types:
        return False
    if values == EXISTS:
        return True
    return cond_values != EXISTS and cond_values <= values


@pytest.mark.parametrize("poi_type", sorted(_parse_lua()))
def test_prefilter_keeps_everything_the_lua_imports(poi_type: str):
    # The osmium pre-filter runs before the Lua ever sees the data, so a
    # type it drops imports no rows - the same silent failure as above. The
    # Lua ANDs its conditions, so covering any one of them is enough.
    scope, conditions = _parse_lua()[poi_type]
    prefilter = _parse_prefilter()
    assert any(_covers(line, scope, cond) for line in prefilter for cond in conditions), (
        f"postgis/prefilter.txt drops every {poi_type} ({scope}: {sorted(conditions)})"
    )
