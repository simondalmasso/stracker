# STRACKER — Map Provider Privacy V2

## Runtime providers

```text
RENDERER=MapLibre GL JS
VECTOR_PROVIDER=OpenFreeMap public service
VECTOR_DATA=OpenStreetMap/OpenMapTiles-compatible
SATELLITE_PROVIDER=EOxCloudless public WMTS
SATELLITE_WMTS_LAYER=s2cloudless_3857
ACCOUNT_REQUIRED=NO
API_TOKEN_REQUIRED=NO
MAP_PROVIDER_BILLING_ACCOUNT=NO
```

## Request timing

No style, vector tile, raster tile, glyph or sprite request is allowed before the user selects a location source and an accepted snapshot unlocks the map.

After unlock, the browser may request:

- OpenFreeMap style, vector tiles, glyphs and sprites in `vector-3d` and `hybrid`;
- EOxCloudless raster tiles in `satellite` and `hybrid`;
- attribution destinations only when the user follows a link.

Changing the basemap does not request geolocation, call the shared-session API or restart shared polling.

## Data visible to providers

The provider/CDN can observe ordinary HTTP metadata including IP address, user agent, requested resources, timing and viewport-derived tile coordinates. In satellite mode, raster tile requests may reveal the approximate viewed area more directly. STRACKER therefore does not claim that all map activity remains only on the device.

The application does not intentionally send:

- Google Location Sharing cookies;
- Cloudflare Access assertions;
- STRACKER service tokens;
- shared-session import material;
- location API payloads.

## Provider identity and retention

Neither selected map provider requires an application account or API key for the configured endpoints. STRACKER sets no map-provider cookie. Provider and CDN retention remains governed by their own published policy and infrastructure and may change independently of STRACKER.

CI records allowed hosts, aggregate request counts and transferred bytes. Retained artifacts exclude authorization headers, cookies, tokens and coordinate values.

## Selected satellite imagery

```text
PROVIDER=EOxCloudless
WMTS_LAYER=s2cloudless_3857
ENDPOINT_HOST=tiles.maps.eox.at
LICENSE=CC BY 4.0
IMAGERY_PERIOD=2016-2017 mosaic
RESOLUTION=10 m
RECENT_CLAIM_ALLOWED=NO
COMPLETE_COVERAGE_CLAIMED=NO
```

The product displays that the imagery is a 2016–2017 mosaic. It is not presented as live or recent. CI validates current WMTS capabilities, a public Santa Fe raster tile, image content type, non-empty bytes and CORS.

## IGN evaluation

- Argenmap hybrid remains blocked because current imagery provenance/licensing is insufficiently explicit for release and historical official documentation identifies Google imagery.
- Public IGN orthomosaics remain a partial-coverage candidate. STRACKER does not claim complete Santa Fe coverage, uniform resolution or a current capture date.
- No private API, reverse-engineered URL, token bypass or prohibited Google tile endpoint is used.

## Source-specific privacy

### MI UBICACIÓN

- starts `watchPosition()` only after explicit action;
- keeps filter state, stable coordinate and GhostRail in memory;
- does not call shared-session APIs;
- does not persist coordinates by default;
- exposes only normal viewport tile requests after map unlock.

### UBICACIÓN COMPARTIDA

- calls same-origin STRACKER gateway routes only;
- never sends origin cookies or service tokens to map providers;
- does not interpolate remote points;
- keeps polling/session state unchanged during basemap transitions;
- aborts and invalidates pending requests only on location-source change.

## Dynamic attribution

Attribution remains visible above the bottom sheet and changes with active layers:

```text
VECTOR_3D: OpenFreeMap · OpenMapTiles · OpenStreetMap
SATELLITE: EOxCloudless · EOX · modified Copernicus Sentinel data 2016 & 2017
HYBRID: satellite attribution + OpenFreeMap/OpenStreetMap attribution
```

## Failure behavior

A failed raster provider or bounded availability timeout produces `SATÉLITE NO DISPONIBLE EN ESTA ZONA`. Tracking, marker, accuracy, GhostRail, timestamps and camera state remain available. STRACKER does not silently substitute a paid or unauthorized provider.

## Exact-head validation

```text
VALIDATED_FEATURE_HEAD=2faa42dc127099d97acc28a9404c9cd75a0e9efc
WORKFLOW_RUN_ID=29855942179
PROVIDER_ARTIFACT_ID=8505304475
PROVIDER_ARTIFACT_DIGEST=sha256:18e94400cfc5568db95374865948ad16758bbe77e111706861b3286bd2bd5174
```
