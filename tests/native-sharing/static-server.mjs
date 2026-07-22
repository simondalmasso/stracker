import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const root = process.env.STATIC_ROOT || 'out'
const port = Number(process.env.PORT || 4173)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }

function resolvePath(pathname) {
  if (/^\/shared\/[A-Za-z0-9_.-]+\/?$/.test(pathname)) return join(root, 'shared', '__capability__', 'index.html')
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, '')
  let candidate = join(root, clean)
  if (pathname.endsWith('/')) candidate = join(candidate, 'index.html')
  else if (!extname(candidate)) candidate = join(candidate, 'index.html')
  return candidate
}

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  const file = resolvePath(url.pathname)
  if (!file.startsWith(join(process.cwd(), root)) && !file.startsWith(root)) {
    response.writeHead(404).end()
    return
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'Cache-Control': 'no-store' }).end()
    return
  }
  response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  createReadStream(file).pipe(response)
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`ready:${port}\n`))
