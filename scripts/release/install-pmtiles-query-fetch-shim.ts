export {}

const globalState = globalThis as typeof globalThis & { __strackerPmtilesQueryFetchShimV1?: boolean }

if (!globalState.__strackerPmtilesQueryFetchShimV1) {
  const upstream = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname.endsWith('.pmtiles')) {
      const headers = new Headers(request.headers)
      const range = headers.get('Range')
      const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null
      if (match) {
        const offset = Number(match[1])
        const end = Number(match[2])
        if (Number.isSafeInteger(offset) && Number.isSafeInteger(end) && offset >= 0 && end >= offset) {
          url.search = ''
          url.searchParams.set('pmtilesOffset', String(offset))
          url.searchParams.set('pmtilesLength', String(end - offset + 1))
          return upstream(url, {
            method: 'GET',
            headers,
            cache: request.cache,
            credentials: request.credentials,
            integrity: request.integrity,
            keepalive: request.keepalive,
            mode: request.mode,
            redirect: request.redirect,
            referrer: request.referrer,
            referrerPolicy: request.referrerPolicy,
            signal: request.signal,
          })
        }
      }
    }
    return upstream(input, init)
  }) as typeof fetch
  globalState.__strackerPmtilesQueryFetchShimV1 = true
}
