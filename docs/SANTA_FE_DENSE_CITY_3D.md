# Santa Fe dense city 3D v1

Order: `STRACKER-AUD-SANTA-FE-DENSE-CITY-3D-V1`.

## Scope

The dataset is public, city-scale LOD1 massing for Santa Fe Capital, Argentina. It is not a photorealistic mesh and does not copy Hop.Earth assets or styling. It uses open building footprints and deterministic visual-height estimates so a mobile browser can show dense blocks, vertical walls, elevated roofs and height variation.

No owner location, screenshot coordinate, cookie session, private share link, capability, marker, tracking history or production payload is an input to this pipeline.

## Pinned sources and licences

- Overture Maps release `2026-07-22.0`, Buildings theme, `building` and `building_part`.
- Overture building data is ODbL because it contains OpenStreetMap-derived features.
- Attribution: `© OpenStreetMap contributors; © Overture Maps Foundation`.
- The public urban envelope is a simplified city-scale envelope derived from the public OpenStreetMap/Nominatim Santa Fe place result. It is stored at `data/santa-fe-3d/public-urban-boundary.geojson`.
- Tool and source pins are in `data/santa-fe-3d/source-lock.json`.

The output manifest records bounded-input digests, boundary checksum, source release, tool versions, feature counts, height provenance and the content hash of the PMTiles file.

## Reproducible build

The manual materialization workflow is `.github/workflows/stracker-santa-fe-3d-materialize-v1.yml`. Its implementation is:

```bash
SOURCE_SHA="$(git rev-parse HEAD)" bash scripts/santa-fe-3d/materialize.sh
```

The workflow installs pinned versions of `overturemaps-py`, Shapely, pyproj, Tippecanoe and go-pmtiles. It performs a bbox-pushdown read of the pinned Overture release; it does not download a planet-wide dataset.

Pipeline stages:

1. read bounded `building` and `building_part` records;
2. repair polygonal geometry, clip to the public envelope and remove slivers;
3. retain useful parts and suppress covered parent footprints;
4. remove duplicate geometries;
5. preserve explicit heights, derive floor heights, then use deterministic area/class/hash estimates;
6. emit GeoJSONSeq with required provenance properties;
7. tile layer `santa_fe_buildings_3d` into MBTiles;
8. convert and verify PMTiles v3;
9. rename the archive with its SHA-256 prefix and emit `manifest.json` plus generated TypeScript constants.

## Runtime and fallback

Within the Santa Fe envelope the custom PMTiles layer is authoritative and generic OpenFreeMap building extrusions are hidden. Outside that envelope, the existing generic building fallback remains available.

The PMTiles archive is a content-hashed static asset. Production must return `206 Partial Content` and a valid `Content-Range` for a byte-range request. It must remain under Cloudflare's 25 MiB individual static-asset limit; 24 MiB is the project target.

## Height semantics

`height` and `min_height` are metres. `height_source` is one of `explicit`, `floors`, `estimated`, or `fallback`. Estimates are visual massing, not survey measurements. `height_confidence` is `high`, `medium`, or `low`.

## Public QA fixtures

- Downtown civic/commercial fixture: `[-60.7006, -31.6332]`.
- Boulevard/Candioti mixed residential fixture: `[-60.6818, -31.6208]`.

These are fixed public city fixtures and are not derived from any private user location.
