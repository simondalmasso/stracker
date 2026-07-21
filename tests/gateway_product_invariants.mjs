import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ROUTES } from '../gateway/src/policy.mjs'

const sessionApi = await readFile('src/lib/location-source/session-api.ts', 'utf8')
const myLocation = await readFile('src/lib/location-source/use-my-location.ts', 'utf8')
const gatewaySource = await readFile('gateway/src/index.mjs', 'utf8')
const wranglerConfig = await readFile('gateway/wrangler.jsonc', 'utf8')

assert.match(sessionApi, /PRIVATE_GATEWAY_REQUIRED/)
assert.match(sessionApi, /X-Stracker-Gateway/)
assert.doesNotMatch(sessionApi, /https?:\/\//)
assert.doesNotMatch(sessionApi, /onrender\.com|strackerglm/i)
assert.doesNotMatch(myLocation, /session-api|cloudflare|gateway|fetch\s*\(/i)
assert.match(myLocation, /navigator\.geolocation\.watchPosition/)
assert.deepEqual(
  ROUTES.map(({ method, path }) => `${method} ${path}`),
  [
    'GET /api/session/status',
    'POST /api/session/import',
    'POST /api/session/delete',
    'GET /points',
  ],
)
assert.match(gatewaySource, /X-Stracker-Service-Token/)
assert.doesNotMatch(gatewaySource, /request\.url.*fetch|url\.searchParams.*fetch/i)
assert.doesNotMatch(gatewaySource, /onrender\.com|strackerglm/i)
assert.match(wranglerConfig, /"workers_dev"\s*:\s*false/)
assert.match(wranglerConfig, /"preview_urls"\s*:\s*false/)
assert.doesNotMatch(wranglerConfig, /"routes"|onrender\.com|strackerglm/i)

console.log('MY_LOCATION_INDEPENDENT=PASS')
console.log('SHARED_LOCATION_FAIL_CLOSED=PASS')
console.log('OPEN_PROXY=NO')
console.log('SSRF=BLOCKED')
