// @ts-nocheck
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import sharp from 'sharp'
import manifest from '../../public/data/santa-fe-3d/manifest.json'

const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const LAYER = 'santa_fe_buildings_3d'
const FIXTURES = [
  { id: 'PUBLIC_SANTA_FE_DENSE_CENTRAL_V1', center: [-60.7003, -31.6401], zoom: 16.8, pitch: 58, bearing: 24, min: 80 },
  { id: 'PUBLIC_SANTA_FE_MIXED_RISE_V1', center: [-60.6738, -31.6237], zoom: 16.6, pitch: 56, bearing: 28, min: 40 },
]
class Failure extends Error { constructor(readonly code: string) { super(code) } }
function ok(v, code) { if (!v) throw new Failure(code) }
function override(version) { return version ? { 'Cloudflare-Workers-Version-Overrides': `stracker="${version}"` } : {} }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function safe(value) { return String(value || 'UNKNOWN').replace(/https?:\/\/\S+/gi, '[URL]').replace(/[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{43})?/g, '[CAPABILITY]').replace(/[^A-Z0-9_[\]-]+/gi, '_').slice(0, 160) }

async function runtimeIdentity(o) {
  if (!o.targetUrl) return
  const target = new URL(o.targetUrl); ok(target.protocol === 'https:', 'MAP3D_HTTPS_REQUIRED')
  const headers = { Accept: 'application/json', 'Cache-Control': 'no-cache', ...override(o.overrideVersion || '') }
  let code = 'MAP3D_IDENTITY_UNAVAILABLE'
  for (let i = 1; i <= 30; i++) {
    const q = `${Date.now()}-${i}`
    const [br, vr] = await Promise.all([
      fetch(new URL(`/__stracker/build.json?map3d=${q}`, target), { headers, cache: 'no-store' }),
      fetch(new URL(`/__stracker/version.json?map3d=${q}`, target), { headers, cache: 'no-store' }),
    ])
    const b = await br.json().catch(() => null), v = await vr.json().catch(() => null)
    if (!br.ok || !vr.ok || !b || !v) code = 'MAP3D_IDENTITY_UNAVAILABLE'
    else if (b.sourceSha !== o.expectedSha) code = 'MAP3D_BUILD_SHA_MISMATCH'
    else if (b.release !== 'controlled-physical-pilot-v1') code = 'MAP3D_RELEASE_MISMATCH'
    else if (v.sourceSha !== o.expectedSha) code = 'MAP3D_VERSION_SHA_MISMATCH'
    else if (v.versionId !== o.expectedVersionId) code = 'MAP3D_VERSION_ID_MISMATCH'
    else return
    if (i < 30) await Bun.sleep(1000)
  }
  throw new Failure(code)
}

async function targetRange(o) {
  if (!o.targetUrl) return { checked: 0, transferredBytes: 0 }
  const target = new URL(o.targetUrl), headers = { 'Cache-Control': 'no-cache', ...override(o.overrideVersion || '') }
  const mr = await fetch(new URL(`/data/santa-fe-3d/manifest.json?rangeqa=${Date.now()}`, target), { headers, cache: 'no-store' })
  ok(mr.status === 200, 'TARGET_MANIFEST_UNAVAILABLE')
  const remote = await mr.json()
  ok(remote.final_features >= 200000 && remote.unique_height_bucket_count >= 6 && remote.uniform_default_height_fraction < .35, 'TARGET_MANIFEST_CONTRACT')
  let bytes = 0
  for (const path of remote.asset_paths) {
    const r = await fetch(new URL(`${path}?rangeqa=${Date.now()}`, target), { headers: { ...headers, Range: 'bytes=0-16383' }, cache: 'no-store' })
    const body = await r.arrayBuffer(), cr = r.headers.get('content-range') || ''
    ok(r.status === 206, 'TARGET_RANGE_NOT_206'); ok(/^bytes 0-\d+\/\d+$/.test(cr), 'TARGET_CONTENT_RANGE')
    ok(r.headers.get('accept-ranges')?.toLowerCase() === 'bytes', 'TARGET_ACCEPT_RANGES')
    ok(body.byteLength > 0 && body.byteLength <= 16384, 'TARGET_RANGE_UNBOUNDED'); bytes += body.byteLength
  }
  return { checked: remote.asset_paths.length, transferredBytes: bytes }
}

function entrySource() { return `
import maplibregl from 'maplibre-gl'
import { acquireSantaFePmtilesProtocol, configureSantaFeCity3d } from './src/lib/location-source/map-engine/santa-fe-city-runtime'
import { SANTA_FE_3D_LAYER_IDS } from './src/lib/location-source/map-engine/santa-fe-city-config'
import { setLightCityBaseStyle } from './src/lib/location-source/map-engine/openfreemap-style'
const fixtures=${JSON.stringify(FIXTURES)}, ids=SANTA_FE_3D_LAYER_IDS, release=acquireSantaFePmtilesProtocol(), started=performance.now()
let first=null
const map=new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/liberty',center:fixtures[0].center,zoom:fixtures[0].zoom,pitch:fixtures[0].pitch,bearing:fixtures[0].bearing,maxPitch:65,preserveDrawingBuffer:true,attributionControl:false,fadeDuration:0})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
function marker(center){const data={type:'Feature',properties:{},geometry:{type:'Point',coordinates:center}};if(!map.getSource('qa-marker-source'))map.addSource('qa-marker-source',{type:'geojson',data});else map.getSource('qa-marker-source').setData(data);if(!map.getLayer('qa-marker'))map.addLayer({id:'qa-marker',type:'circle',source:'qa-marker-source',paint:{'circle-radius':9,'circle-color':'#fff','circle-stroke-color':'#15191d','circle-stroke-width':3}})}
function snap(f){const layers=map.getStyle().layers||[], visible=ids.filter(id=>map.getLayer(id)&&map.getLayoutProperty(id,'visibility')!=='none'), features=visible.length?map.queryRenderedFeatures({layers:visible}):[], heights=[...new Set(features.map(x=>Number(x.properties?.height)).filter(x=>Number.isFinite(x)&&x>=3).map(x=>Math.round(x*10)/10))], bi=visible.map(id=>layers.findIndex(x=>x.id===id)).filter(x=>x>=0), max=bi.length?Math.max(...bi):-1;return{fixtureId:f.id,visible:visible.length>0,layerCount:visible.length,renderedFeatureCount:features.length,uniqueHeightCount:heights.length,sourceLayer:visible.length?(layers.find(x=>x.id===visible[0])?.['source-layer']||null):null,zoom:map.getZoom(),pitch:map.getPitch(),labelsAboveBuildings:max>=0&&layers.findIndex(x=>x.type==='symbol')>max,markerAboveBuildings:max>=0&&layers.findIndex(x=>x.id==='qa-marker')>max}}
async function fixture(i){const f=fixtures[i];map.jumpTo({center:f.center,zoom:f.zoom,pitch:f.pitch,bearing:f.bearing});configureSantaFeCity3d(map,{enabled:true,density:'full',center:{lng:f.center[0],lat:f.center[1]},origin:location.origin});marker(f.center);const end=Date.now()+50000;let s=snap(f);while(Date.now()<end){map.triggerRepaint();await sleep(350);s=snap(f);if(s.renderedFeatureCount>=f.min&&s.uniqueHeightCount>=6){if(first===null)first=Math.round(performance.now()-started);return s}}return s}
async function toggle(on){const f=fixtures[0];configureSantaFeCity3d(map,{enabled:on,density:'full',center:{lng:f.center[0],lat:f.center[1]},origin:location.origin});map.triggerRepaint();await sleep(1000);return snap(f)}
async function fps(){let n=0,start=performance.now();await new Promise(done=>{const frame=()=>{n++;performance.now()-start>=2000?done():requestAnimationFrame(frame)};requestAnimationFrame(frame)});return Math.round(n*1000/Math.max(1,performance.now()-start))}
map.once('load',async()=>{try{setLightCityBaseStyle(map);const snapshots=[await fixture(0),await fixture(1)];window.__qa={ready:true,snapshots,firstInteractiveMs:first??Math.round(performance.now()-started),fixture,toggle,fps}}catch(e){window.__qa={ready:false,error:String(e?.message||e)}}})
window.addEventListener('beforeunload',release)
` }

async function stats(image) { const r = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); let dark = 0; for (let i=0;i<r.data.length;i+=r.info.channels) if (r.data[i]<48&&r.data[i+1]<48&&r.data[i+2]<48) dark++; return { darkPixelShare: dark/Math.max(1,r.info.width*r.info.height) } }
async function diff(a,b) { const [l,r]=await Promise.all([sharp(a).ensureAlpha().raw().toBuffer({resolveWithObject:true}),sharp(b).ensureAlpha().raw().toBuffer({resolveWithObject:true})]); let changed=0,total=0; for(let i=0;i<l.data.length;i+=l.info.channels){const d=Math.abs(l.data[i]-r.data[i])+Math.abs(l.data[i+1]-r.data[i+1])+Math.abs(l.data[i+2]-r.data[i+2]);total+=d;if(d>=18)changed++} return {changedPixels:changed,meanAbsoluteDelta:total/Math.max(1,l.info.width*l.info.height*3)} }

async function installGeo(page) { const f=FIXTURES[0]; await page.evaluateOnNewDocument((p)=>{let id=1;const active=new Map(),position=()=>({coords:{latitude:p.lat,longitude:p.lng,accuracy:4,altitude:null,altitudeAccuracy:null,heading:25,speed:0,toJSON:()=>({})},timestamp:Date.now(),toJSON:()=>({})});Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(s){setTimeout(()=>s(position()),10)},watchPosition(s){const n=id++;active.set(n,s);setTimeout(()=>{if(active.has(n))s(position())},50);return n},clearWatch(n){active.delete(n)}}})},{lng:f.center[0],lat:f.center[1]}) }
async function click(page,text){await page.waitForFunction(v=>[...document.querySelectorAll('button')].some(b=>b.textContent?.toUpperCase().includes(String(v).toUpperCase())),{timeout:30000},text);await page.$$eval('button',(bs,v)=>{const b=bs.find(x=>x.textContent?.toUpperCase().includes(String(v).toUpperCase()));if(!b)throw Error('BUTTON_NOT_FOUND');b.click()},text)}

async function publicApp(o, dir) {
  if (!o.targetUrl) return null
  const target=new URL(o.targetUrl), d={attempts:0,rootStatus:null,pageErrors:[],consoleErrors:[],pmtilesRequests:0,pmtilesRequestsWithoutRange:0,pmtiles206Responses:0,pmtilesContentRangeResponses:0}
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader','--disable-dev-shm-usage']})
  try {
    const page=await browser.newPage();await page.setViewport({width:390,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true});await installGeo(page);await page.setRequestInterception(true)
    page.on('request',r=>{void(async()=>{const u=new URL(r.url()),same=u.origin===target.origin;if(same&&u.pathname.endsWith('.pmtiles')){d.pmtilesRequests++;if(!r.headers().range)d.pmtilesRequestsWithoutRange++}await r.continue({headers:same&&o.overrideVersion?{...r.headers(),'Cloudflare-Workers-Version-Overrides':`stracker="${o.overrideVersion}"`}:r.headers()})})().catch(()=>r.abort().catch(()=>{}))})
    page.on('response',r=>{try{const u=new URL(r.url());if(u.origin===target.origin&&u.pathname.endsWith('.pmtiles')){if(r.status()===206)d.pmtiles206Responses++;if(/^bytes \d+-\d+\/\d+$/.test(r.headers()['content-range']||''))d.pmtilesContentRangeResponses++}}catch{}})
    page.on('pageerror',e=>d.pageErrors.push(safe(e instanceof Error?e.message:'PAGEERROR')));page.on('console',m=>{if(m.type()==='error')d.consoleErrors.push(safe(m.text()))})
    let ready=false;for(let i=1;i<=4;i++){d.attempts=i;const r=await page.goto(new URL(`/?dense3d=${Date.now()}-${i}`,target).href,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);d.rootStatus=r?.status()??null;ready=await page.waitForFunction(()=>document.body.textContent?.includes('¿Qué ubicación querés ver?'),{timeout:25000}).then(()=>true).catch(()=>false);if(ready)break;if(i<4)await Bun.sleep(5000)}
    ok(ready,`TARGET_ROOT_NOT_READY_${d.rootStatus??'NO_STATUS'}`);await click(page,'MI UBICACIÓN');await click(page,'PERMITIR UBICACIÓN');await page.waitForSelector('main[data-map-engine="maplibre"][data-location-source="my-device"][data-map-provider="available"]',{timeout:90000})
    const deadline=Date.now()+90000;while(d.pmtiles206Responses===0&&Date.now()<deadline)await Bun.sleep(500);ok(d.pmtiles206Responses>0,'TARGET_PMTILES_NOT_RENDERING');await Bun.sleep(5000)
    const perf=await page.evaluate(()=>{const m=document.querySelector('main[data-map-engine="maplibre"]');return{providerState:m?.getAttribute('data-map-provider'),firstVisibleMs:Number(m?.getAttribute('data-map-first-visible-ms'))||null,firstInteractiveMs:Number(m?.getAttribute('data-map-first-interactive-ms'))||null,estimatedFps:Number(m?.getAttribute('data-map-fps'))||null,longTasks:Number(m?.getAttribute('data-map-long-tasks'))||0,transferredBytes:Number(m?.getAttribute('data-map-transferred-bytes'))||0}})
    const canvas=await page.$('canvas.maplibregl-canvas'),clip=await canvas?.boundingBox();ok(clip,'TARGET_CANVAS_MISSING');const on=await page.screenshot({clip});await page.click('button[aria-label="Activar o desactivar edificios 3D"]');await Bun.sleep(1200);const off=await page.screenshot({clip});await page.click('button[aria-label="Activar o desactivar edificios 3D"]');await Bun.sleep(3000)
    const delta=await diff(on,off),light=await stats(on);ok(delta.changedPixels>=8000&&delta.meanAbsoluteDelta>=.35,'TARGET_VISIBLE_EFFECT_LOW');ok(light.darkPixelShare<.42,'TARGET_STYLE_DARK');ok(d.pageErrors.length===0,'TARGET_PAGE_ERROR');if(d.consoleErrors.length)console.error(`TARGET_MAP3D_CONSOLE=${d.consoleErrors.join(',')}`);ok(d.consoleErrors.length===0,'TARGET_CONSOLE_ERROR');ok(d.pmtilesRequests>0&&d.pmtilesRequestsWithoutRange===0,'TARGET_FULL_PMTILES_REQUEST');ok(d.pmtiles206Responses>0&&d.pmtilesContentRangeResponses>0,'TARGET_BROWSER_RANGE')
    await Bun.write(join(dir,'santa-fe-dense-city-public-on.png'),on);await Bun.write(join(dir,'santa-fe-dense-city-public-off.png'),off)
    return {...d,...perf,changedPixels:delta.changedPixels,meanAbsoluteDelta:Math.round(delta.meanAbsoluteDelta*10000)/10000,darkPixelShare:Math.round(light.darkPixelShare*1000000)/1000000,screenshots:[{name:'santa-fe-dense-city-public-on.png',sha256:digest(on)},{name:'santa-fe-dense-city-public-off.png',sha256:digest(off)}]}
  } finally { await browser.close() }
}

export async function runMap3dRuntimeQa(o={}) {
  if(o.targetUrl){ok(/^[0-9a-f]{40}$/.test(o.expectedSha||''),'EXPECTED_SHA_REQUIRED');ok(o.expectedVersionId,'EXPECTED_VERSION_REQUIRED')}
  await runtimeIdentity(o);const remoteRange=await targetRange(o),work=await mkdtemp(join(tmpdir(),'stracker-map3d-')),entry=join(process.cwd(),`.map3d-${process.pid}-${Date.now()}.ts`),dir=o.screenshotDir||join(process.env.RUNNER_TEMP||'/tmp','stracker-controlled-physical-pilot-release')
  let browser,server;const ranges={requests:0,fullRequests:0,transferredBytes:0,maxResponseBytes:0,contentRangeFailures:0}
  try {
    await mkdir(dir,{recursive:true});await writeFile(entry,entrySource());const build=await Bun.build({entrypoints:[entry],target:'browser',format:'esm',outdir:work});ok(build.success&&build.outputs.length===1,'BUNDLE_FAILED');const bundle=await build.outputs[0].text(),css=await Bun.file(join(process.cwd(),'node_modules/maplibre-gl/dist/maplibre-gl.css')).text()
    server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const path=new URL(req.url).pathname;if(path==='/fixture.js')return new Response(bundle,{headers:{'Content-Type':'text/javascript'}});if(path==='/maplibre.css')return new Response(css,{headers:{'Content-Type':'text/css'}});if(path.startsWith('/data/santa-fe-3d/')&&path.endsWith('.pmtiles')){const relative=path.replace(/^\//,'');let file=Bun.file(join(process.cwd(),'out',relative));if(!(await file.exists()))file=Bun.file(join(process.cwd(),'public',relative));if(!(await file.exists()))return new Response('missing',{status:404});const h=req.headers.get('range');if(!h){ranges.fullRequests++;return new Response('range required',{status:416,headers:{'Accept-Ranges':'bytes'}})}const m=/^bytes=(\d+)-(\d*)$/.exec(h);if(!m)return new Response('range',{status:416});const start=Number(m[1]),end=Math.min(file.size-1,m[2]?Number(m[2]):file.size-1);if(start<0||end<start||start>=file.size)return new Response('range',{status:416});const body=await file.slice(start,end+1).arrayBuffer();ranges.requests++;ranges.transferredBytes+=body.byteLength;ranges.maxResponseBytes=Math.max(ranges.maxResponseBytes,body.byteLength);const cr=`bytes ${start}-${end}/${file.size}`;return new Response(body,{status:206,headers:{'Content-Type':'application/octet-stream','Accept-Ranges':'bytes','Content-Range':cr,'Content-Length':String(body.byteLength)}})}return new Response('<html><head><link rel="stylesheet" href="/maplibre.css"><style>html,body,#map{width:100%;height:100%;margin:0;background:#f2f1ed}</style></head><body><div id="map"></div><script type="module" src="/fixture.js"></script></body></html>',{headers:{'Content-Type':'text/html'}})}})
    browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader','--disable-dev-shm-usage']});const page=await browser.newPage();await page.setViewport({width:390,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true});const pe=[],ce=[];page.on('pageerror',e=>pe.push(safe(e instanceof Error?e.message:'PAGEERROR')));page.on('console',m=>{if(m.type()==='error')ce.push(safe(m.text()))});await page.goto(`http://${server.hostname}:${server.port}/`,{waitUntil:'domcontentloaded',timeout:90000});await page.waitForFunction(()=>window.__qa?.ready===true||Boolean(window.__qa?.error),{timeout:120000});const initial=await page.evaluate(()=>window.__qa);ok(initial?.ready===true,`FIXTURE_${safe(initial?.error||'NOT_READY')}`);ok(pe.length===0,'LOCAL_PAGE_ERROR');if(ce.length)console.error(`LOCAL_MAP3D_CONSOLE=${ce.join(',')}`)
    for(let i=0;i<FIXTURES.length;i++){const s=initial.snapshots[i];ok(s.layerCount===manifest.asset_paths.length,`FIXTURE_${i}_LAYERS`);ok(s.sourceLayer===LAYER,`FIXTURE_${i}_SOURCE`);ok(s.renderedFeatureCount>=FIXTURES[i].min,`FIXTURE_${i}_DENSITY_${s.renderedFeatureCount}`);ok(s.uniqueHeightCount>=6,`FIXTURE_${i}_HEIGHTS`);ok(s.pitch>=52&&s.pitch<=60,`FIXTURE_${i}_PITCH`);ok(s.labelsAboveBuildings,`FIXTURE_${i}_LABELS`);ok(s.markerAboveBuildings,`FIXTURE_${i}_MARKER`)}
    await page.evaluate(()=>window.__qa.fixture(0));const box=await (await page.$('#map'))?.boundingBox();ok(box,'LOCAL_CANVAS');const on=await page.screenshot({clip:box}),offState=await page.evaluate(()=>window.__qa.toggle(false)),off=await page.screenshot({clip:box}),onState=await page.evaluate(()=>window.__qa.toggle(true)),delta=await diff(on,off),light=await stats(on),fps=await page.evaluate(()=>window.__qa.fps());ok(!offState.visible&&offState.renderedFeatureCount===0,'TOGGLE_OFF');ok(onState.visible&&onState.renderedFeatureCount>=FIXTURES[0].min,'TOGGLE_ON');ok(delta.changedPixels>=8000&&delta.meanAbsoluteDelta>=.35,'LOCAL_VISIBLE_EFFECT');ok(light.darkPixelShare<.42,'LOCAL_STYLE_DARK');ok(initial.firstInteractiveMs<=12000,'LOCAL_INTERACTIVE_BUDGET');ok(fps>=24,'LOCAL_FPS');ok(ranges.requests>0&&ranges.fullRequests===0,'LOCAL_RANGE');ok(ranges.maxResponseBytes<=4*1024*1024,'LOCAL_RANGE_UNBOUNDED');ok(ranges.transferredBytes<manifest.asset_sizes.reduce((a,b)=>a+b,0),'FULL_CITY_DOWNLOAD');await Bun.write(join(dir,'santa-fe-dense-city-on.png'),on);await Bun.write(join(dir,'santa-fe-dense-city-off.png'),off)
    const publicResult=await publicApp(o,dir),selected=initial.snapshots[0],result={schema:'stracker.santa-fe-dense-city-3d-runtime-qa.v3',sourceSha:o.expectedSha||null,targetRuntimeVerified:Boolean(o.targetUrl),fixtureId:selected.fixtureId,fixtures:initial.snapshots,privateDataUsed:false,realUserCoordinatesUsed:false,coordinateValuesRetained:false,renderedFeatureCount:selected.renderedFeatureCount,source:'same-origin-content-addressed-pmtiles',sourceLayer:LAYER,uniqueHeightCount:selected.uniqueHeightCount,fallbackUsed:false,changedPixels:delta.changedPixels,meanAbsoluteDelta:Math.round(delta.meanAbsoluteDelta*10000)/10000,darkPixelShare:Math.round(light.darkPixelShare*1000000)/1000000,firstInteractiveMs:initial.firstInteractiveMs,estimatedFps:fps,localRange:ranges,targetRange:remoteRange,targetApplication:publicResult,screenshots:[{name:'santa-fe-dense-city-on.png',sha256:digest(on)},{name:'santa-fe-dense-city-off.png',sha256:digest(off)},...(publicResult?.screenshots||[])],assetPaths:manifest.asset_paths,assetSizes:manifest.asset_sizes,assetSha256:manifest.asset_sha256,featureCount:manifest.final_features,heightSourceCounts:manifest.height_source_counts,uniqueHeightBucketCount:manifest.unique_height_bucket_count,uniformDefaultHeightFraction:manifest.uniform_default_height_fraction,gates:{MAP_3D_RUNTIME_TESTS:'PASS',SANTA_FE_DENSE_CITY_FIXTURE_A:'PASS',SANTA_FE_DENSE_CITY_FIXTURE_B:'PASS',SAME_ORIGIN_CONTENT_ADDRESSED_PMTILES:'PASS',PMTILES_RANGE_REQUESTS_BOUNDED:'PASS',PMTILES_CONTENT_RANGE:'PASS',NO_FULL_CITY_ASSET_DOWNLOAD:'PASS',FILL_EXTRUSION_LAYER_RESOLVED:'PASS',BUILDING_SOURCE_AND_SOURCE_LAYER_RESOLVED:'PASS',RENDERED_BUILDING_FEATURES_GT_ZERO:'PASS',DENSE_CITY_BLOCK_MASSING:'PASS',WALLS_AND_ROOFS_VISIBLE:'PASS',UNIQUE_EFFECTIVE_HEIGHT_BUCKETS_GTE_6:'PASS',BUILDING_TOGGLE_VISIBLE_EFFECT:'PASS',LIGHT_CITY_STYLE:'PASS',MARKER_ABOVE_BUILDINGS:'PASS',LABELS_USABLE_ABOVE_BUILDINGS:'PASS',A22_PERFORMANCE_BUDGET_SYNTHETIC:'PASS',PUBLIC_FIXTURES_ONLY:'PASS',NO_PRIVATE_DATA_IN_QA:'PASS',...(publicResult?{PUBLIC_RUNTIME_DENSE_SANTA_FE_3D:'PASS',PUBLIC_RUNTIME_ROOT_READY_AFTER_BOUNDED_PROPAGATION_WAIT:'PASS',PUBLIC_RUNTIME_PMTILES_BROWSER_RANGE:'PASS',PUBLIC_RUNTIME_LIGHT_CITY_STYLE:'PASS',PUBLIC_RUNTIME_BUILDING_TOGGLE_VISIBLE_EFFECT:'PASS'}:{})}}
    if(o.output)await Bun.write(o.output,JSON.stringify(result,null,2)+'\n');return result
  } finally {await browser?.close();server?.stop(true);await rm(entry,{force:true});await rm(work,{recursive:true,force:true})}
}

if(import.meta.main){const r=await runMap3dRuntimeQa({targetUrl:process.env.STRACKER_QA_URL,expectedSha:process.env.STRACKER_EXPECTED_SHA,expectedVersionId:process.env.STRACKER_EXPECTED_VERSION_ID,overrideVersion:process.env.STRACKER_VERSION_OVERRIDE,output:process.env.STRACKER_MAP3D_QA_OUTPUT||'/tmp/stracker-map3d-runtime-qa.json',screenshotDir:process.env.STRACKER_MAP3D_SCREENSHOT_DIR});console.log(`MAP_3D_RUNTIME_QA=PASS fixture=${r.fixtureId} features=${r.renderedFeatureCount}`)}
