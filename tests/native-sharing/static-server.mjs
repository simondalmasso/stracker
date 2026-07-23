import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

const root = resolve(process.env.STATIC_ROOT || 'out')
const port = Number(process.env.PORT || 4173)
const defaultSyntheticCapability = `${'S'.repeat(43)}.${'V'.repeat(43)}`
const syntheticCapability = process.env.QA_SYNTHETIC_CAPABILITY || defaultSyntheticCapability
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const sharedCsp = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.openfreemap.org https://*.eox.at",
  "connect-src 'self' https://*.openfreemap.org https://*.eox.at",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "child-src blob:",
  "manifest-src 'self'",
].join('; ')

let requestObservations = []

function safeCandidate(relative) {
  const candidate = resolve(root, relative)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null
}

function resolvePath(pathname) {
  const decoded = decodeURIComponent(pathname)
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  if (decoded === '/') return safeCandidate('index.html')

  const relative = decoded.replace(/^\/+/, '').replace(/\/$/, '')
  if (!relative || relative.split('/').some((part) => part === '..')) return null
  if (extname(relative)) return safeCandidate(relative)

  return safeCandidate(`${relative}.html`) || safeCandidate(`${relative}/index.html`)
}

function qaHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }
}

const server = createServer((request, response) => {
  const requestTarget = request.url || '/'
  const url = new URL(requestTarget, 'http://127.0.0.1')

  if (url.pathname === '/__qa__/request-observations') {
    if (request.method === 'POST') {
      requestObservations = []
      response.writeHead(204, qaHeaders()).end()
      return
    }
    if (request.method === 'GET') {
      response.writeHead(200, qaHeaders()).end(JSON.stringify({ observations: requestObservations }))
      return
    }
    response.writeHead(405, { ...qaHeaders(), Allow: 'GET, POST' }).end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }))
    return
  }

  requestObservations.push({
    method: request.method || 'GET',
    pathname: url.pathname,
    queryPresent: Boolean(url.search),
    capabilityPresent: requestTarget.includes(syntheticCapability),
  })

  const baseHeaders = qaHeaders('application/octet-stream')
  if (url.search) {
    response.writeHead(400, baseHeaders).end()
    return
  }
  const file = resolvePath(url.pathname)
  if (!file) {
    response.writeHead(404, baseHeaders).end()
    return
  }
  const isShared = url.pathname === '/shared' || url.pathname === '/shared/'
  const headers = {
    ...baseHeaders,
    'Content-Type': types[extname(file)] || 'application/octet-stream',
  }
  if (isShared) {
    headers['Content-Security-Policy'] = sharedCsp
    headers['Permissions-Policy'] = 'geolocation=(), camera=(), microphone=()'
    headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive, nosnippet'
  }
  response.writeHead(200, headers)
  createReadStream(file).pipe(response)
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`ready:${port}\n`))
