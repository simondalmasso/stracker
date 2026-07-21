import { createServer } from 'node:http'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const mapboxRoot = process.env.MAPBOX_BENCHMARK_ROOT
const output = process.env.MAP_SPIKE_OUTPUT || '/tmp/stracker-map-spike-raw.json'
if (!mapboxRoot) throw new Error('MAPBOX_BENCHMARK_ROOT is required')

const engines = {
  maplibre: {
    global: 'maplibregl',
    js: path.resolve('node_modules/maplibre-gl/dist/maplibre-gl.js'),
    css: path.resolve('node_modules/maplibre-gl/dist/maplibre-gl.css'),
    versionPath: path.resolve('node_modules/maplibre-gl/package.json'),
  },
  mapbox: {
    global: 'mapboxgl',
    js: path.resolve(mapboxRoot, 'node_modules/mapbox-gl/dist/mapbox-gl.js'),
    css: path.resolve(mapboxRoot, 'node_modules/mapbox-gl/dist/mapbox-gl.css'),
    versionPath: path.resolve(mapboxRoot, 'node_modules/mapbox-gl/package.json'),
  },
}

const fixture = {
  type: 'FeatureCollection',
  name: 'STRACKER_SYNTHETIC_SANTA_FE_RENDERER_FIXTURE',
  features: [
    {
      type: 'Feature',
      properties: { kind: 'route' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-60.7010, -31.6340],
          [-60.7004, -31.6336],
          [-60.6998, -31.6331],
          [-60.6991, -31.6327],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { kind: 'point' },
      geometry: { type: 'Point', coordinates: [-60.6998, -31.6331] },
    },
    ...Array.from({ length: 24 }, (_, index) => {
      const row = Math.floor(index / 6)
      const column = index % 6
      const west = -60.702 + column * 0.00055
      const south = -31.635 + row * 0.00055
      const size = 0.00032
      return {
        type: 'Feature',
        properties: { kind: 'building', height: 8 + (index % 7) * 4 },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [west, south],
            [west + size, south],
            [west + size, south + size],
            [west, south + size],
            [west, south],
          ]],
        },
      }
    }),
  ],
}

function html(engineName) {
  const engine = engines[engineName]
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/${engineName}.css"><style>html,body,#map{margin:0;width:100%;height:100%;background:#050505}</style></head>
<body><div id="map"></div><script src="/${engineName}.js"></script><script>
const started = performance.now();
const longTasks = [];
try { new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration))).observe({type:'longtask', buffered:true}); } catch {}
const fixture = ${JSON.stringify(fixture)};
const buildings = {type:'FeatureCollection',features:fixture.features.filter(item=>item.properties.kind==='building')};
const route = {type:'FeatureCollection',features:fixture.features.filter(item=>item.properties.kind==='route')};
const point = {type:'FeatureCollection',features:fixture.features.filter(item=>item.properties.kind==='point')};
const style = {version:8,sources:{buildings:{type:'geojson',data:buildings},route:{type:'geojson',data:route},point:{type:'geojson',data:point}},layers:[
{id:'background',type:'background',paint:{'background-color':'#050505'}},
{id:'buildings',type:'fill-extrusion',source:'buildings',paint:{'fill-extrusion-color':'#30353a','fill-extrusion-height':['get','height'],'fill-extrusion-base':0,'fill-extrusion-opacity':0.7}},
{id:'route',type:'line',source:'route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#f5f7f8','line-width':4}},
{id:'point-halo',type:'circle',source:'point',paint:{'circle-radius':18,'circle-color':'#ffffff','circle-opacity':0.12,'circle-blur':0.55}},
{id:'point',type:'circle',source:'point',paint:{'circle-radius':8,'circle-color':'#ffffff','circle-stroke-color':'#050505','circle-stroke-width':3}}
]};
const Engine = window['${engine.global}'];
if ('accessToken' in Engine) Engine.accessToken = '';
window.__benchmark = new Promise((resolve, reject) => {
  let loadMs = null; let idleMs = null; let frames = 0; let frameStart = performance.now();
  const map = new Engine.Map({container:'map',style,center:[-60.6998,-31.6331],zoom:15.8,pitch:60,bearing:24,antialias:true,attributionControl:false,fadeDuration:0});
  map.on('error', event => { if (event?.error) console.warn('MAP_ENGINE_ERROR', event.error.message || String(event.error)); });
  map.once('load', () => {
    loadMs = performance.now() - started;
    const canvas = map.getCanvas();
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const layer = map.getLayer('buildings');
    map.easeTo({center:[-60.6991,-31.6327],zoom:16.4,pitch:55,bearing:42,duration:450});
    const tick = () => { frames += 1; if (performance.now() - frameStart < 1800) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    map.once('idle', () => {
      idleMs = performance.now() - started;
      setTimeout(() => resolve({
        engine:'${engineName}',
        fixture:fixture.name,
        loadMs,
        idleMs,
        webgl:Boolean(gl),
        renderer:gl ? gl.getParameter(gl.RENDERER) : null,
        buildings3d:Boolean(layer && layer.type === 'fill-extrusion'),
        camera:{zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing(),centerValuesRetained:false},
        frames,
        estimatedFps:Math.round(frames / 1.8),
        longTasks:longTasks.length,
        longTaskDurationMs:longTasks.reduce((sum,value)=>sum+value,0),
        memory:performance.memory ? {usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize} : null
      }), 1900);
    });
  });
  setTimeout(() => reject(new Error('benchmark timeout')), 15000);
});
</script></body></html>`
}

const servedBytes = { maplibre: 0, mapbox: 0 }
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/maplibre' || url.pathname === '/mapbox') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(html(url.pathname.slice(1)))
      return
    }
    for (const [name, engine] of Object.entries(engines)) {
      if (url.pathname === `/${name}.js` || url.pathname === `/${name}.css`) {
        const file = url.pathname.endsWith('.js') ? engine.js : engine.css
        const body = await readFile(file)
        servedBytes[name] += body.byteLength
        response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css')
        response.end(body)
        return
      }
    }
    response.statusCode = 404
    response.end('not found')
  } catch (error) {
    response.statusCode = 500
    response.end(String(error))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage', '--enable-precise-memory-info'],
})

const results = []
try {
  for (const name of Object.keys(engines)) {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    const consoleErrors = []
    const externalHosts = new Set()
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('request', request => {
      const requestUrl = new URL(request.url())
      if (requestUrl.hostname !== '127.0.0.1') externalHosts.add(requestUrl.hostname)
    })
    await page.goto(`http://127.0.0.1:${port}/${name}`, { waitUntil: 'load' })
    const result = await page.evaluate(() => window.__benchmark)
    const pkg = JSON.parse(await readFile(engines[name].versionPath, 'utf8'))
    const jsBytes = (await stat(engines[name].js)).size
    const cssBytes = (await stat(engines[name].css)).size
    results.push({
      ...result,
      packageVersion: pkg.version,
      jsBytes,
      cssBytes,
      servedBytes: servedBytes[name],
      consoleErrorCount: consoleErrors.length,
      externalHosts: [...externalHosts].sort(),
    })
    await page.close()
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

const raw = {
  schema: 'stracker.renderer-benchmark.v1',
  generatedAt: new Date().toISOString(),
  benchmarkClassification: 'RENDERER_BENCHMARK_ONLY',
  fullStackParityClaimed: false,
  fixture: fixture.name,
  fixtureCoordinateValuesRetained: false,
  viewport: { width: 390, height: 844 },
  dataProvider: 'LOCAL_SYNTHETIC_GEOJSON_ONLY',
  engines: results,
  decisionInputs: {
    recurringInfrastructureCostUsd: 0,
    mapProviderCostUsd: 0,
    paidOverageAllowed: false,
    automaticUpgradeToPaid: false,
    billingDependency: false,
  },
}
await writeFile(output, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
for (const result of results) {
  if (!result.webgl || !result.buildings3d) throw new Error(`${result.engine} renderer benchmark failed`)
  if (result.externalHosts.length > 0) throw new Error(`${result.engine} benchmark made external requests`)
}
console.log(`MAP_SPIKE_RAW_RESULTS=${output}`)
console.log('RENDERER_BENCHMARK=PASS')
console.log('FULL_STACK_PARITY_CLAIMED=NO')
