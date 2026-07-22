# Google identity and Google Maps session separation

## Two independent concepts

```text
GOOGLE_IDENTITY_LOGIN
GOOGLE_MAPS_SESSION_LINK
```

They never share credentials, lifecycle, storage or authorization semantics.

```text
GOOGLE_ID_TOKEN_OR_ACCESS_IDENTITY
!=
GOOGLE_MAPS_SESSION
!=
STRACKER_SERVICE_TOKEN
```

## GOOGLE_IDENTITY_LOGIN

When live infrastructure is separately authorized, Cloudflare Access is the sole application identity authority. Google is configured as the Access identity provider. The hosted Access login experience owns:

```text
[ CONTINUAR CON GOOGLE ]
```

Flow:

```text
User
→ Google identity provider
→ Cloudflare Access
→ STRACKER
```

The React application does not implement a second Google login, does not receive Google identity-provider client secrets, and does not exchange identity credentials itself. Access validates the identity before STRACKER is reached. The Worker validates `CF-Access-Jwt-Assertion` on every protected API request.

This login authenticates access to STRACKER only. It does not create, import, validate or unlock a Google Maps Location Sharing session.

## GOOGLE_MAPS_SESSION_LINK

Inside `UBICACIÓN COMPARTIDA`, the product presents:

```text
[ VINCULAR GOOGLE MAPS ]
Importar una sesión autorizada
```

Flow:

```text
VINCULAR GOOGLE MAPS
→ choose supported export format
→ import session
→ normalize and validate server-side
→ encrypt with AES-GCM
→ persist in D1 under a hash of the Access subject
→ return sanitized status only
```

The session values never return to the browser. Public responses may contain only format classification, counts, required-cookie names, health classification and remediation text. No cookie value is logged or included in validation artifacts.

## Independent expiration and revocation

Cloudflare Access identity and the Google Maps session are checked independently on every relevant request.

- An accepted Access identity with no stored Google Maps session returns `SHARED_SESSION_REQUIRED`.
- An accepted Access identity with an expired or rejected Google Maps session remains authenticated to STRACKER but cannot open shared location.
- A revoked or expired Access identity blocks STRACKER even if an encrypted Google Maps session remains stored.
- Deleting the Google Maps session does not sign the user out of Cloudflare Access.
- Signing out of Access does not reinterpret the Google Maps session as an identity credential.

## Product states

```text
NO VINCULADA
VALIDANDO
VINCULADA
SESIÓN VENCIDA
SESIÓN RECHAZADA
GOOGLE NO DISPONIBLE
```

A valid session can expose `ABRIR UBICACIÓN`. Identity login alone never does.

## Truthful protocol description

The Google Maps link is not presented as an official public Google Location Sharing API and not as an OAuth authorization flow. STRACKER processes an explicitly imported, authorized browser session in the backend and queries the existing Google Maps Location Sharing endpoint fail-closed. The endpoint is undocumented and may change.

## Live configuration boundary

This branch contains code, fixtures, placeholder bindings and documentation only. It does not create a Google OAuth client, Cloudflare Access identity provider, Access application, D1 database, Worker version, deployment, route, DNS record or secret.

A future live setup requires separate authorization because it involves real identity-provider credentials and Cloudflare account mutations.

## Required gates

```text
GOOGLE_LOGIN_DOES_NOT_UNLOCK_SHARED_LOCATION=PASS
SHARED_SESSION_REQUIRED=PASS
IDENTITY_AND_SESSION_SEPARATED=PASS
NO_FALSE_OAUTH_CLAIM=PASS
```
