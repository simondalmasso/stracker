export {}

const originalFetch = globalThis.fetch.bind(globalThis)
const metadataPaths = new Set(['/__stracker/version.json', '/__stracker/build.json'])

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return new URL(input.href)
  if (typeof input === 'string') return new URL(input)
  return new URL(input.url)
}

async function curlMetadata(url: URL, init?: RequestInit): Promise<Response> {
  const requestHeaders = new Headers(init?.headers)
  const args = [
    'curl',
    '--silent',
    '--show-error',
    '--max-time',
    '20',
    '--write-out',
    '\n%{http_code}',
    '-H',
    `Accept: ${requestHeaders.get('Accept') || 'application/json'}`,
    '-H',
    `Cache-Control: ${requestHeaders.get('Cache-Control') || 'no-cache'}`,
  ]
  const versionOverride = requestHeaders.get('Cloudflare-Workers-Version-Overrides')
  if (versionOverride) args.push('-H', `Cloudflare-Workers-Version-Overrides: ${versionOverride}`)
  args.push(url.href)

  const subprocess = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ])
  if (exitCode !== 0) return new Response('', { status: 503 })

  const boundary = stdout.lastIndexOf('\n')
  if (boundary < 0) return new Response('', { status: 503 })
  const body = stdout.slice(0, boundary)
  const parsedStatus = Number(stdout.slice(boundary + 1).trim())
  const status = Number.isInteger(parsedStatus) && parsedStatus >= 200 && parsedStatus <= 599 ? parsedStatus : 503
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0',
    },
  })
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = requestUrl(input)
  if (metadataPaths.has(url.pathname) && process.env.STRACKER_VERSION_OVERRIDE) {
    url.searchParams.set('transport', `curl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    return curlMetadata(url, init)
  }
  return originalFetch(input, init)
}) as typeof fetch

process.env.STRACKER_EXPECTED_RELEASE ||= 'controlled-physical-pilot-v1'
const core = new URL(`file://${process.cwd()}/scripts/release/live-native-sharing-api-qa-core.ts`)
await import(core.href)
