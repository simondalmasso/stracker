#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${SOURCE_SHA:?SOURCE_SHA required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${RUNNER_TEMP:-/tmp}/stracker-santa-fe-3d"
OUT="$ROOT/public/data/santa-fe-3d"
GEOJSONSEQ="$WORK/santa-fe-buildings.geojsonseq"
STATS="$WORK/extraction-stats.json"
MBTILES="$WORK/santa-fe-buildings.mbtiles"
PMTILES_TMP="$OUT/santa-fe-buildings-3d.pmtiles"

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK" "$OUT"
cp "$ROOT/data/santa-fe-3d/public-urban-boundary.geojson" "$OUT/public-urban-boundary.geojson"
cp "$ROOT/data/santa-fe-3d/source-lock.json" "$OUT/source-lock.json"

python "$ROOT/scripts/santa-fe-3d/build_city.py" extract \
  --boundary "$ROOT/data/santa-fe-3d/public-urban-boundary.geojson" \
  --output "$GEOJSONSEQ" \
  --stats "$STATS"

tippecanoe \
  --force \
  --output="$MBTILES" \
  --layer=santa_fe_buildings_3d \
  --minimum-zoom=13 \
  --maximum-zoom=18 \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --simplification=2 \
  --detect-shared-borders \
  --name="STRACKER Santa Fe dense city 3D" \
  --description="Public low-poly LOD1 building massing for Santa Fe Capital, Argentina" \
  --attribution="© OpenStreetMap contributors; © Overture Maps Foundation" \
  --include=height \
  --include=min_height \
  --include=height_source \
  --include=height_confidence \
  --include=building_class \
  --include=source_dataset \
  --include=source_feature_id_or_stable_hash \
  --include=footprint_area_m2 \
  "$GEOJSONSEQ"

pmtiles convert "$MBTILES" "$PMTILES_TMP"
pmtiles verify "$PMTILES_TMP"
pmtiles show "$PMTILES_TMP" --header-json > "$WORK/pmtiles-header.json"
pmtiles show "$PMTILES_TMP" --metadata > "$WORK/pmtiles-metadata.json"
jq -e '.tile_type == "mvt" and .minzoom <= 13 and .maxzoom >= 17' "$WORK/pmtiles-header.json" >/dev/null
jq -e '.vector_layers[] | select(.id == "santa_fe_buildings_3d")' "$WORK/pmtiles-metadata.json" >/dev/null

SOURCE_SHA="$SOURCE_SHA" python "$ROOT/scripts/santa-fe-3d/build_city.py" finalize \
  --pmtiles "$PMTILES_TMP" \
  --stats "$STATS" \
  --generated-ts "$ROOT/src/lib/location-source/map-engine/santa-fe-3d-generated.ts"

test "$(find "$OUT" -maxdepth 1 -name '*.pmtiles' -type f | wc -l)" = 1
jq -e '.final_features >= 5000 and .unique_height_bucket_count >= 6 and .uniform_default_height_fraction < 0.35' "$OUT/manifest.json" >/dev/null
jq -e '.asset_under_25_mib_hard_limit == true and .private_tracking_data_in_assets == false' "$OUT/manifest.json" >/dev/null
echo "SANTA_FE_3D_MATERIALIZATION=PASS"
