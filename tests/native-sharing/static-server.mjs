import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

const root = resolve(process.env.STATIC_ROOT || 'out')
const port = Number(process.env.PORT || 4173)
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

function resolvePath(pathname) {
  const decoded = decodeURIComponent(pathname)
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const relative = decoded === '/' ? 'index.html' : `${decoded.replace(/^\/+/, '').replace(/\/$/, '')}${extname(decoded) ? '' : '/index.html'}`
  const candidate = resolve(root, relative)
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null
}

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (url.search) {
    response.writeHead(400, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end()
    return
  }
  const file = resolvePath(url.pathname)
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end()
    return
  }
  const isShared = url.pathname === '/shared' || url.pathname === '/shared/'
  const headers = {
    'Content-Type': types[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
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
