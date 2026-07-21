# STRACKER — Map Provider Privacy V1

## Selected runtime

```text
RENDERER=MapLibre GL JS
STYLE_AND_TILE_PROVIDER=OpenFreeMap public service
BASE_DATA=OpenStreetMap/OpenMapTiles-compatible
ACCOUNT_REQUIRED=NO
API_TOKEN_REQUIRED=NO
MAP_PROVIDER_BILLING_ACCOUNT=NO
```

## Browser requests

After and only after the user selects a source and a real accepted location snapshot unlocks the map, the browser requests:

- the OpenFreeMap style document;
- vector tile resources referenced by that style;
- glyphs and sprites referenced by the style;
- attribution links only if the user follows them.

The provider and its CDN can observe normal HTTP metadata such as requested resources, IP address, user agent, timing and approximate viewport-derived tile coordinates. STRACKER must not claim that all map activity remains only on the device.

No map provider request is permitted before source selection. No provider request contains the STRACKER shared-session cookie material or origin service token.

## Cookies and identity

OpenFreeMap documents that its public service does not require accounts, API keys or cookies. STRACKER does not set a provider cookie and does not send Google cookies, Cloudflare Access assertions or STRACKER service tokens to the map provider.

Third-party browser or CDN behavior can change independently; CI therefore records request hosts, response headers and cookies observed during QA.

## IP processing and logs

OpenFreeMap documents privacy-oriented anonymized operational logging and states that IP addresses are not logged by default. It also reserves temporary IP logging during security incidents, with documented deletion after a limited period. Cloudflare CDN infrastructure may process network metadata while delivering the service.

STRACKER treats these statements as provider documentation, not as a technical guarantee controlled by STRACKER.

## Telemetry

MapLibre is configured without a Mapbox token or Mapbox telemetry endpoint. The application does not intentionally send location analytics to MapLibre, OpenFreeMap or OpenStreetMap.

The browser still emits ordinary tile/style network traffic. CI records hosts, request counts and transferred bytes but sanitizes query values, cookies, authorization headers and coordinates from retained artifacts.

## Retention

STRACKER controls only its own application logs and artifacts. Provider/CDN retention is governed by provider policy and may change. The current decision must be revalidated before release if those terms change.

## Source-specific privacy

### MI UBICACIÓN

- uses `navigator.geolocation.watchPosition()` after explicit action;
- keeps filter state and GhostRail in memory;
- does not call shared-session APIs;
- does not persist coordinates by default;
- does expose viewport tile requests to the selected map provider after map unlock.

### UBICACIÓN COMPARTIDA

- calls same-origin STRACKER gateway routes only;
- never sends Google cookie material to the map provider;
- renders accepted shared points through the same provider requests as `MI UBICACIÓN`;
- stops polling and aborts pending requests on source change.

## Attribution

Visible attribution is mandatory and may not be hidden or covered:

```text
OpenFreeMap
OpenMapTiles
OpenStreetMap
```

The mobile shell includes an accessible attribution region above the bottom sheet. CI verifies that it has a non-zero visible bounding box at every required viewport.

## Self-hosting and migration

OpenFreeMap and compatible OpenMapTiles data can be self-hosted, subject to data and software licenses and infrastructure capacity. This PR does not self-host tiles because that would introduce a runtime/storage phase outside scope.

The adapter isolates provider configuration for a future PMTiles or self-hosted migration. Such a migration requires its own cost, storage, update, attribution and privacy validation.

## Provider comparison summary

| Dimension | Mapbox data/style | OpenFreeMap + OSM |
|---|---|---|
| Account/token | Required for normal Mapbox service | Not required for current public service |
| Billing dependency | Yes | No current billing account |
| Hard pre-charge cap | Does not meet STRACKER requirement | No billing path in current public service |
| Browser IP visible | Yes | Yes, through provider/CDN delivery |
| Cookies/account identity | Provider-account model | No account/cookie requirement documented |
| Lock-in | Proprietary style/data APIs | Open renderer and compatible style/data schemas |
| Self-host path | Restricted by selected services/data terms | OpenFreeMap/OpenMapTiles-compatible self-host path |
| SLA | Commercial service terms | Public service is as-is, no SLA |
