#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${SOURCE_SHA:?SOURCE_SHA required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${RUNNER_TEMP:-/tmp}/stracker-santa-fe-3d"
OUT="$ROOT/public/data/santa-fe-3d"
GEOJSONSEQ="$WORK/santa-fe-buildings.geojsonseq"
SHARD_DIR="$WORK/shards"
STATS="$WORK/extraction-stats.json"

stage() { printf 'STAGE=%s STATUS=%s\n' "$1" "$2"; }

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK" "$OUT" "$SHARD_DIR"
cp "$ROOT/data/santa-fe-3d/public-urban-boundary.geojson" "$OUT/public-urban-boundary.geojson"
cp "$ROOT/data/santa-fe-3d/source-lock.json" "$OUT/source-lock.json"

stage BUILD_GEOJSONSEQ START
python "$ROOT/scripts/santa-fe-3d/build_city_streaming.py" extract \
  --boundary "$ROOT/data/santa-fe-3d/public-urban-boundary.geojson" \
  --output "$GEOJSONSEQ" \
  --stats "$STATS"
test -s "$GEOJSONSEQ"
test -s "$STATS"
python "$ROOT/scripts/santa-fe-3d/shard_geojsonseq.py" --input "$GEOJSONSEQ" --output-dir "$SHARD_DIR"
stage BUILD_GEOJSONSEQ PASS

PMTILES_ARGS=()
for shard in north-west north-east south-west south-east; do
  shard_input="$SHARD_DIR/${shard}.geojsonseq"
  mbtiles="$WORK/santa-fe-buildings-${shard}.mbtiles"
  pmtiles="$OUT/santa-fe-buildings-3d-${shard}.pmtiles"
  test -s "$shard_input"

  stage "TIPPECANOE_MBTILES_${shard}" START
  tippecanoe \
    --force \
    --output="$mbtiles" \
    --layer=santa_fe_buildings_3d \
    --minimum-zoom=13 \
    --maximum-zoom=17 \
    --drop-densest-as-needed \
    --drop-smallest-as-needed \
    --extend-zooms-if-still-dropping \
    --simplification=4 \
    --detect-shared-borders \
    --name="STRACKER Santa Fe dense city 3D ${shard}" \
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
    "$shard_input"
  test -s "$mbtiles"
  stage "TIPPECANOE_MBTILES_${shard}" PASS

  stage "PMTILES_CONVERT_${shard}" START
  pmtiles convert "$mbtiles" "$pmtiles"
  test -s "$pmtiles"
  pmtiles verify "$pmtiles"
  pmtiles show "$pmtiles" --header-json > "$WORK/pmtiles-${shard}-header.json"
  jq -e '.tile_type == "mvt" and .minzoom <= 13 and .maxzoom >= 17' "$WORK/pmtiles-${shard}-header.json" >/dev/null
  pmtiles show "$pmtiles" --metadata > "$WORK/pmtiles-${shard}-metadata.json"
  jq -e '.vector_layers[] | select(.id == "santa_fe_buildings_3d")' "$WORK/pmtiles-${shard}-metadata.json" >/dev/null
  stage "PMTILES_CONVERT_${shard}" PASS
  PMTILES_ARGS+=("$pmtiles")
done

stage FINALIZE_MANIFEST START
SOURCE_SHA="$SOURCE_SHA" python "$ROOT/scripts/santa-fe-3d/finalize_shards.py" \
  --stats "$STATS" \
  --generated-ts "$ROOT/src/lib/location-source/map-engine/santa-fe-3d-generated.ts" \
  --pmtiles "${PMTILES_ARGS[@]}"
stage FINALIZE_MANIFEST PASS

stage STATIC_ASSET_VALIDATION START
test "$(find "$OUT" -maxdepth 1 -name '*.pmtiles' -type f | wc -l)" = 4
jq -e '.final_features >= 5000 and .unique_height_bucket_count >= 6 and .uniform_default_height_fraction < 0.35' "$OUT/manifest.json" >/dev/null
jq -e '.asset_shard_count == 4 and .asset_under_25_mib_hard_limit == true and .private_tracking_data_in_assets == false' "$OUT/manifest.json" >/dev/null
python "$ROOT/scripts/santa-fe-3d/validate_static_asset.py" --manifest "$OUT/manifest.json" --root "$ROOT/public"
stage STATIC_ASSET_VALIDATION PASS
echo "SANTA_FE_3D_MATERIALIZATION=PASS"
