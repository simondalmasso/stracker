# STRACKER Deployment Controls

## Platform separation

```text
RENDER_PRODUCTION=UNCHANGED
CLOUDFLARE_STAGING=AUTHORIZED_NONPROD_ONLY
PRODUCTION_TRAFFIC=0%
DNS_CHANGES=PROHIBITED
CUSTOM_DOMAINS=PROHIBITED
```

A staging Worker Deployment is not a production deployment.

## Staging source

```text
BASE_SHA=77a937b4b157c2ec2c47940d6fe6891cf10b74c9
BRANCH=feat/stracker-cloudflare-nonprod-live-v1
BACKEND_WORKER=stracker-backend-mock-staging
GATEWAY_WORKER=stracker-gateway-staging
```

The exact tree, frozen install, build and tests must pass before remote mutation.

## Remote preflight

Before creating a Version, the workflow must resolve and verify:

1. a Cloudflare API token already available to GitHub Actions;
2. one exact account ID;
3. the existing Zero Trust organization and team domain;
4. one exact authorized operator identity;
5. the prior staging deployment and workers.dev state.

The workflow must fail closed if any input is ambiguous. It does not generate a broad permanent Cloudflare token.

## Auditable Worker flow

`wrangler deploy` is prohibited for this phase.

For each Worker:

```text
wrangler versions upload
→ capture Version ID
→ wrangler versions view
→ inspect binding names
→ wrangler versions deploy <version>@100%
→ verify active Deployment ID
```

```text
WORKER_VERSION != WORKER_DEPLOYMENT
```

## Safe exposure sequence

1. Deploy `stracker-backend-mock-staging` with no public ingress.
2. Deploy a gateway bootstrap with workers.dev and preview URLs disabled.
3. Create or reconcile Access for the exact gateway Worker.
4. Replace staging policies with one exact operator allow rule.
5. Verify default deny and the exact Worker destination.
6. Upload and deploy the final gateway Version with exact Access configuration.
7. Enable one workers.dev surface with previews disabled.
8. Immediately prove unauthenticated root and API requests are blocked before Worker execution.

No temporary public window is accepted.

## Secrets

The synthetic staging token is generated per workflow run and uploaded through a mode-0600 temporary file using `--secrets-file`. It is masked before any command and removed at completion.

Non-secret configuration:

```text
ACCESS_TEAM_DOMAIN
ACCESS_AUD
```

Secret binding:

```text
STRACKER_SERVICE_TOKEN
```

## Validation

Remote completion requires:

- mock backend Version and Deployment active;
- backend workers.dev and previews disabled;
- gateway Version and Deployment active;
- Access application and exact policy active;
- unauthenticated traffic blocked;
- authenticated HTTP and browser flow passing;
- live Service Binding proof;
- five mobile viewports passing;
- security adversarial checks passing;
- production traffic remaining zero.

## Rollback

Before each deployment, prior active versions are recorded. On a security failure:

1. disable the gateway workers.dev surface;
2. keep Access default-deny;
3. restore the previous gateway version if one exists;
4. restore the previous backend version if one exists;
5. preserve sanitized evidence;
6. do not touch Render, DNS or production.

Worker versions do not capture changes to KV, D1, R2, Durable Objects or external systems. None are created in this phase.
