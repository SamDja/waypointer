-- osm2pgsql flex-output script for Waypointer's PostGIS POI import.
--
-- Hand-mirrors src/waypointer/poi_types.py's searchable tag_filter entries
-- (only the ones with a tag_filter set) so this import brings in just the
-- OSM features Waypointer actually cares about, not a full-region dataset.
-- This is the same "keep two implementations in sync by hand" tradeoff the
-- repo already accepts for frontend/src/lib/poiTypes.ts mirroring
-- poi_types.py - but unlike that one, this mirror IS checked:
-- tests/test_import_pois_lua.py parses the FILTERS table below and each
-- tag_filter in poi_types.py and asserts they describe the same tags, with
-- the same scope. It parses strictly, so an entry written in a shape the
-- parser doesn't recognise fails the test rather than going unchecked - if
-- you add a condition form here, teach the test about it.
--
-- Note that changing a filter is not enough on its own: the `pois` table
-- only holds rows for tags that were already being imported, so a widened
-- filter finds nothing until `docker compose run --rm poi-import` is run
-- again, locally and on the Pi.
--
-- No --slim/updatable state is used - this is a one-shot static import, not
-- a continuously-updated mirror (see postgis/update_check.sh for the
-- threshold-gated reimport that replaces staying current), so osm_type/
-- osm_id are plain columns we set ourselves rather than osm2pgsql's
-- automatic id-tracking machinery.

local pois = osm2pgsql.define_table({
    name = 'pois',
    ids = { type = 'any', id_column = 'db_id' }, -- surrogate PK only, not used for lookups
    columns = {
        { column = 'osm_type', type = 'text', not_null = true },
        { column = 'osm_id', type = 'int8', not_null = true },
        { column = 'poi_type', type = 'text', not_null = true },
        { column = 'tags', type = 'jsonb' },
        -- object.timestamp is a Unix epoch integer (seconds), not a string
        -- - verified against osm2pgsql 1.8's actual flex behavior, not
        -- documentation. Stored as-is (int8) rather than converted to a
        -- timestamp here in Lua; poi_db.py's _iso() converts epoch seconds
        -- to an ISO 8601 string at read time instead.
        { column = 'osm_timestamp', type = 'int8' },
        { column = 'geom', type = 'geometry', not_null = true, projection = 4326 },
    },
})

-- `scope` restricts which OSM element kinds a filter applies to: "any"
-- (node/way/relation, mirrors poi_types.py's nwr[...] filters), "node", or
-- "way" - see poi_types.py itself for why most searchable types are "any"
-- (PR #15: many real-world POIs, e.g. a mountain hut, are mapped as a way
-- or relation, not a point). `match` conditions are AND'd together; `in_`
-- is a same-key "value in set" OR, mirroring poi_types.py's
-- regex-alternation filters (e.g. `shop~"^(supermarket|convenience|grocery)$"`).
local FILTERS = {
    water           = { scope = 'any',  match = { { key = 'amenity', value = 'drinking_water' } } },
    hospital        = { scope = 'any',  match = { { key = 'amenity', value = 'hospital' } } },
    pharmacy        = { scope = 'any',  match = { { key = 'amenity', value = 'pharmacy' } } },
    bar             = { scope = 'any',  match = { { key = 'amenity', value = 'bar' } } },
    bike_shop       = { scope = 'any',  match = { { key = 'shop', value = 'bicycle' } } },
    coffee          = { scope = 'any',  match = { { key = 'amenity', value = 'cafe' } } },
    food            = { scope = 'any',  match = { { key = 'amenity', value = 'restaurant' } } },
    gas_station     = { scope = 'any',  match = { { key = 'amenity', value = 'fuel' } } },
    groceries       = { scope = 'any',  match = { { key = 'shop', in_ = { 'supermarket', 'convenience', 'grocery' } } } },
    shopping        = { scope = 'any',  match = { { key = 'shop', exists = true } } },
    winery          = { scope = 'any',  match = { { key = 'shop', value = 'wine' } } },
    info            = { scope = 'any',  match = { { key = 'tourism', value = 'information' } } },
    lodging         = { scope = 'any',  match = { { key = 'tourism', in_ = { 'hotel', 'hostel', 'guest_house', 'motel', 'alpine_hut', 'wilderness_hut' } } } },
    shower          = { scope = 'any',  match = { { key = 'amenity', value = 'shower' } } },
    toilet          = { scope = 'any',  match = { { key = 'amenity', value = 'toilets' } } },
    bike_parking    = { scope = 'any',  match = { { key = 'amenity', value = 'bicycle_parking' } } },
    bike_share      = { scope = 'any',  match = { { key = 'amenity', value = 'bicycle_rental' } } },
    chairlift       = { scope = 'way',  match = { { key = 'aerialway', value = 'chair_lift' } } },
    e_bike_charging = { scope = 'any',  match = { { key = 'amenity', value = 'charging_station' }, { key = 'bicycle', value = 'yes' } } },
    ferry           = { scope = 'any',  match = { { key = 'amenity', value = 'ferry_terminal' } } },
    parking         = { scope = 'any',  match = { { key = 'amenity', value = 'parking' } } },
    transit         = { scope = 'node', match = { { key = 'highway', value = 'bus_stop' } } },
    campsite        = { scope = 'any',  match = { { key = 'tourism', value = 'camp_site' } } },
    dog_park        = { scope = 'any',  match = { { key = 'leisure', value = 'dog_park' } } },
    park            = { scope = 'any',  match = { { key = 'leisure', value = 'park' } } },
    rest_area       = { scope = 'any',  match = { { key = 'highway', value = 'rest_area' } } },
    swimming        = { scope = 'any',  match = { { key = 'leisure', in_ = { 'swimming_pool', 'bathing_place' } } } },
    summit          = { scope = 'node', match = { { key = 'natural', value = 'peak' } } },
    atm             = { scope = 'node', match = { { key = 'amenity', value = 'atm' } } },
    art             = { scope = 'any',  match = { { key = 'tourism', value = 'artwork' } } },
    attraction      = { scope = 'any',  match = { { key = 'tourism', value = 'attraction' } } },
    monument        = { scope = 'any',  match = { { key = 'historic', value = 'monument' } } },
    viewpoint       = { scope = 'any',  match = { { key = 'tourism', value = 'viewpoint' } } },
}

local function tag_matches(tags, cond)
    local v = tags[cond.key]
    if v == nil then
        return false
    end
    if cond.exists then
        return true
    end
    if cond.value ~= nil then
        return v == cond.value
    end
    if cond.in_ ~= nil then
        for _, candidate in ipairs(cond.in_) do
            if v == candidate then
                return true
            end
        end
        return false
    end
    return false
end

-- Returns every poi_type key whose filter matches tags for an element of
-- the given scope ("node"/"way"/"relation") - usually 0 or 1, but nothing
-- prevents one OSM feature matching more than one registered type.
local function matching_poi_types(tags, scope)
    local matches = {}
    for poi_type, filter in pairs(FILTERS) do
        if filter.scope == 'any' or filter.scope == scope then
            local all_match = true
            for _, cond in ipairs(filter.match) do
                if not tag_matches(tags, cond) then
                    all_match = false
                    break
                end
            end
            if all_match then
                table.insert(matches, poi_type)
            end
        end
    end
    return matches
end

local function insert_rows(object, geom, scope)
    if not geom or geom:is_null() then
        return
    end
    for _, poi_type in ipairs(matching_poi_types(object.tags, scope)) do
        pois:insert({
            osm_type = scope,
            osm_id = object.id,
            poi_type = poi_type,
            tags = object.tags,
            osm_timestamp = object.timestamp,
            geom = geom,
        })
    end
end

function osm2pgsql.process_node(object)
    insert_rows(object, object:as_point(), 'node')
end

function osm2pgsql.process_way(object)
    -- as_linestring() works for both open and closed ways - a closed way
    -- (e.g. a building outline, a park boundary) still carries every
    -- vertex, which is all poi_db.py's queries need (ST_DumpPoints over the
    -- geometry); true polygon semantics aren't required here.
    insert_rows(object, object:as_linestring(), 'way')
end

function osm2pgsql.process_relation(object)
    -- Only area-type relations (parks, hospital compounds, etc.) have a
    -- well-defined combined geometry via osm2pgsql's own relation builder;
    -- other relation types (bus routes, turn restrictions...) aren't
    -- meaningful POI locations and are skipped.
    if object.tags.type ~= 'multipolygon' and object.tags.type ~= 'boundary' then
        return
    end
    insert_rows(object, object:as_multipolygon(), 'relation')
end
