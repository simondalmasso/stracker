import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(path, 'utf8')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const mobile = read('src/components/mobile/MobileLocationApp.tsx')
const runtime = read('runtime/src/index.ts')
const runtimeContracts = read('runtime/src/contracts.ts')
const docs = read('docs/GOOGLE_IDENTITY_AND_MAPS_SESSION.md')
const wrangler = read('runtime/wrangler.jsonc')
const allProductText = [mobile, runtime, runtimeContracts, docs].join('\n')

assert(docs.includes('GOOGLE_IDENTITY_LOGIN'), 'identity concept missing')
assert(docs.includes('GOOGLE_MAPS_SESSION_LINK'), 'maps session concept missing')
assert(docs.includes('[ CONTINUAR CON GOOGLE ]'), 'Access-hosted Google login UX contract missing')
assert(!mobile.includes('CONTINUAR CON GOOGLE'), 'React must not duplicate Cloudflare Access login')
assert(mobile.includes('VINCULAR GOOGLE MAPS'), 'shared link action missing')
assert(mobile.includes('Importar una sesión autorizada'), 'shared link secondary copy missing')
assert(mobile.includes('ABRIR UBICACIÓN'), 'shared open action missing')
assert(mobile.includes('NO VINCULADA'), 'unlinked state missing')
assert(mobile.includes('SESIÓN VENCIDA'), 'expired state missing')
assert(mobile.includes('SESIÓN RECHAZADA'), 'rejected state missing')
assert(mobile.includes('GOOGLE NO DISPONIBLE'), 'upstream state missing')

for (const forbidden of [
  'AUTORIZAR CON GOOGLE',
  'CONECTAR MEDIANTE OAUTH',
  'API OFICIAL DE LOCATION SHARING',
]) {
  assert(!allProductText.includes(forbidden), `false OAuth/API claim present: ${forbidden}`)
}

assert(runtime.includes("'SHARED_SESSION_REQUIRED'"), 'runtime must require a linked shared session')
assert(runtime.includes('hashIdentitySubject(identity.sub)'), 'session storage must be scoped by Access subject')
assert(runtime.includes('SESSION_ENCRYPTION_KEY'), 'encrypted session binding missing')
assert(runtime.includes('cf-access-jwt-assertion'), 'Access identity assertion missing')
assert(runtime.includes('STRACKER_SERVICE_TOKEN?: string'), 'internal token separation contract missing')
assert(!runtime.includes('STRACKER_SERVICE_TOKEN: body.raw'), 'service token must not derive from Google session')
assert(wrangler.includes('"workers_dev": false'), 'workers.dev must remain disabled')
assert(wrangler.includes('"preview_urls": false'), 'preview URLs must remain disabled')
assert(wrangler.includes('00000000-0000-0000-0000-000000000000'), 'PoC D1 binding must remain placeholder-only')

console.log('GOOGLE_LOGIN_DOES_NOT_UNLOCK_SHARED_LOCATION=PASS')
console.log('SHARED_SESSION_REQUIRED=PASS')
console.log('IDENTITY_AND_SESSION_SEPARATED=PASS')
console.log('NO_FALSE_OAUTH_CLAIM=PASS')
