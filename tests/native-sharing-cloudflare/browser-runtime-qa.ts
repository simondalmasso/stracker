// @ts-nocheck
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import puppeteer from 'puppeteer-core'
import { handleNativeSharingRequest } from '../../native-sharing-cloudflare/src/worker.js'
import { TestNativeSharingNamespace } from './test-runtime.js'

const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const output = process.env.QA_CLOUDFLARE_OUTPUT || '/tmp/native-sharing-cloudflare-browser.json'
const root = process.cwd()
const sizes = [[320,568],[360,640],[375,812],[390,844],[412,915]]
const style = JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#050505'}}]})
const caps = new Set()
const seen = []
const ns = new TestNativeSharingNamespace()
const env = {NATIVE_SHARING:ns,ASSETS:{fetch:asset}}

class AssertionFailure extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const ok = (value,code) => { if (!value) throw new AssertionFailure(code) }
const observations = client => seen.filter(item=>item.client===client)
const stageName = (name,width,height) => `${name}:${width}x${height}`
const waitFor = async (predicate,code,timeout=30000) => {
  const started=Date.now()
  while(Date.now()-started<timeout) {
    if(predicate()) return
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  throw new AssertionFailure(code)
}

function type(path) {
  return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'})[extname(path)] || 'application/octet-stream'
}

async function asset(request) {
  const url = new URL(request.url)
  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (!relative) relative='index.html'
  else if (relative==='share'||relative==='share/') relative='share/index.html'
  else if (relative==='shared'||relative==='shared/') relative='shared/index.html'
  const path=join(root,'out',normalize(relative).replace(/^\.\.(?:\/|\\|$)+/,''))
  try {
    const headers=new Headers({'Content-Type':type(path),'X-Content-Type-Options':'nosniff'})
    if (url.pathname==='/shared'||url.pathname==='/shared/') {
      headers.set('Cache-Control','no-store, max-age=0')
      headers.set('Referrer-Policy','no-referrer')
      headers.set('Permissions-Policy','geolocation=(), camera=(), microphone=()')
      headers.set('X-Robots-Tag','noindex, nofollow, noarchive, nosnippet')
      headers.set('Content-Security-Policy',"default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.openfreemap.org https://*.eox.at; connect-src 'self' https://*.openfreemap.org https://*.eox.at; font-src 'self' data:; worker-src 'self' blob:; child-src blob:; manifest-src 'self'")
    }
    return new Response(await readFile(path),{status:200,headers})
  } catch { return new Response('Not found',{status:404}) }
}

async function click(page,text) {
  await page.waitForFunction(t=>[...document.querySelectorAll('button')].some(b=>b.textContent?.toUpperCase().includes(String(t).toUpperCase())),{},text)
  await page.$$eval('button',(buttons,t)=>{ const b=buttons.find(x=>x.textContent?.toUpperCase().includes(String(t).toUpperCase())); if(!b)throw new Error('BUTTON_NOT_FOUND'); b.click() },text)
}

async function geo(page) {
  await page.evaluateOnNewDocument(()=>{
    const watchers=new Map(); let id=1,seq=0,last=null
    const stats={get:0,watch:0,clear:0,late:0}
    const point=()=>({coords:{latitude:10.1234+(++seq)*.00001,longitude:20.5678+seq*.00001,accuracy:8,altitude:null,altitudeAccuracy:null,heading:null,speed:0,toJSON:()=>({})},timestamp:Date.now()+seq*10000,toJSON:()=>({})})
    Object.defineProperty(navigator,'geolocation',{configurable:true,value:{
      getCurrentPosition(success){stats.get++;last=success;setTimeout(()=>success(point()),0)},
      watchPosition(success){stats.watch++;last=success;const n=id++;watchers.set(n,success);setTimeout(()=>success(point()),0);return n},
      clearWatch(n){stats.clear++;watchers.delete(n)},
    }})
    Object.defineProperty(window,'__geoQA',{value:{stats:()=>({...stats,active:watchers.size}),late:()=>{stats.late++;last?.(point())}}})
  })
}

async function page(context,width,height,errors,requests,client,origin) {
  const p=await context.newPage()
  await p.setViewport({width,height,deviceScaleFactor:1,isMobile:true,hasTouch:true})
  await p.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}])
  await geo(p)
  await p.setRequestInterception(true)
  p.on('pageerror',()=>errors.push('PAGE_ERROR'))
  p.on('request',r=>{ void (async()=>{
    const u=new URL(r.url()), map=u.hostname.endsWith('openfreemap.org')||u.hostname.endsWith('eox.at')||u.hostname.endsWith('openstreetmap.org')
    const body=r.postData()||''
    requests.push({api:u.pathname.startsWith('/api/share/'),map,coordinate:['10.1234','20.5678'].some(v=>r.url().includes(v)||body.includes(v))})
    if(u.hostname==='tiles.openfreemap.org'&&u.pathname.replace(/\/$/,'')==='/styles/liberty') return r.respond({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:style})
    if(map) return r.abort()
    if(u.origin===origin) return r.continue({headers:{...r.headers(),'x-stracker-qa-client':client}})
    return r.continue()
  })().catch(()=>r.abort().catch(()=>{})) })
  return p
}

const stats=p=>p.evaluate(()=>window.__geoQA.stats())
const late=p=>p.evaluate(()=>window.__geoQA.late())
const overflow=async p=>ok(await p.evaluate(()=>Math.max(document.body?.scrollWidth||0,document.documentElement.scrollWidth)<=innerWidth),'HORIZONTAL_OVERFLOW')
const memory=async(p,cap)=>{const s=await p.evaluate(async c=>({local:localStorage.length,session:sessionStorage.length,cookie:document.cookie,db:'databases'in indexedDB?(await indexedDB.databases()).length:0,dom:document.documentElement.innerHTML.includes(c)}),cap);ok(!s.local&&!s.session&&!s.cookie&&!s.db&&!s.dom,'VIEWER_PERSISTENCE')}

const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const u=new URL(request.url); let bodyCap=false
  if(u.pathname==='/api/share/viewer/exchange'){const body=await request.clone().text();bodyCap=[...caps].some(c=>body.includes(c))}
  seen.push({
    client:request.headers.get('x-stracker-qa-client')||'unattributed',
    method:request.method,
    path:u.pathname,
    query:!!u.search,
    urlCap:[...caps].some(c=>request.url.includes(c)),
    bodyCap,
    auth:/^Bearer [A-Za-z0-9_-]{43}$/.test(request.headers.get('Authorization')||''),
  })
  return handleNativeSharingRequest(request,env)
}})
const base=`http://${server.hostname}:${server.port}`
const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader','--disable-dev-shm-usage']})
const result={schema:'stracker.native-sharing-cloudflare-browser.v2',privateDataUsed:false,coordinateValuesRetained:false,secretValuesRetained:false,pageErrorTotal:0,horizontalOverflowTotal:0,capabilityExchangeCountPerViewer:1,viewports:[],gates:{}}
let stage='startup'

try {
  ok((await fetch(`${base}/shared?token=synthetic-only`)).status===400,'SHARED_QUERY_REJECTED')
  for (const [index,[width,height]] of sizes.entries()) {
    const context=await browser.createBrowserContext(),errors=[]
    const rootClient=`qa-${index}-root`,emitterClient=`qa-${index}-emitter`,viewerClient=`qa-${index}-viewer`
    const rootReq=[],rootPage=await page(context,width,height,errors,rootReq,rootClient,base)

    stage=stageName('root-selector',width,height)
    await rootPage.goto(base,{waitUntil:'networkidle0'})
    await rootPage.waitForFunction(()=>document.body.textContent?.includes('¿Qué ubicación querés ver?'))
    await overflow(rootPage)
    let g=await stats(rootPage)
    ok(!g.get&&!g.watch,'ROOT_GEOLOCATION_BEFORE_SELECTION')
    ok(!(await rootPage.$$('main[data-map-engine]')).length,'ROOT_MAP_BEFORE_SELECTION')
    ok(observations(rootClient).every(x=>!x.path.startsWith('/api/share/')),'ROOT_API_BEFORE_SELECTION')
    ok(rootReq.every(x=>!x.api&&!x.map),'ROOT_NETWORK_BEFORE_SELECTION')

    stage=stageName('my-device-permission',width,height)
    await click(rootPage,'MI UBICACIÓN')
    await rootPage.waitForFunction(()=>document.body.textContent?.includes('PERMITIR UBICACIÓN'))
    g=await stats(rootPage)
    ok(!g.get&&!g.watch,'MY_DEVICE_GEOLOCATION_BEFORE_PERMISSION')

    stage=stageName('my-device-map',width,height)
    const myStart=rootReq.length
    await click(rootPage,'PERMITIR UBICACIÓN')
    await rootPage.waitForSelector('main[data-map-engine="maplibre"][data-location-source="my-device"]',{timeout:30000})
    await rootPage.waitForFunction(()=>{const n=document.querySelector('main[data-map-engine]');return n?.dataset.reducedMotion==='true'&&n?.dataset.cameraAnimation==='off'},{timeout:30000})
    await overflow(rootPage)
    g=await stats(rootPage)
    ok(g.watch===1&&!g.get,'MY_DEVICE_WATCH_POSITION')
    ok(rootReq.slice(myStart).every(x=>!x.api&&!x.coordinate),'MY_DEVICE_TRANSPORT')
    ok(await rootPage.$eval('main[data-map-engine]',n=>n.dataset.reducedMotion)==='true','REDUCED_MOTION')
    ok(await rootPage.$eval('main[data-map-engine]',n=>n.dataset.cameraAnimation)==='off','CAMERA_ANIMATION_OFF')
    let a=await rootPage.$eval('[aria-label="Atribución del mapa"]',n=>n.textContent||'')
    ok(a.includes('OpenFreeMap')&&a.includes('OpenStreetMap'),'MY_DEVICE_ATTRIBUTION')

    stage=stageName('source-cleanup',width,height)
    await rootPage.$eval('section[aria-label="Estado de ubicación"] > button',b=>b.click())
    await click(rootPage,'Cambiar ubicación')
    await rootPage.waitForFunction(()=>document.body.textContent?.includes('¿Qué ubicación querés ver?'))
    g=await stats(rootPage)
    ok(g.clear>=1&&!g.active,'SOURCE_CLEANUP')
    await late(rootPage)
    await new Promise(r=>setTimeout(r,150))
    ok(!(await rootPage.$$('main[data-map-engine]')).length,'LATE_RESPONSE_BLOCKED')

    stage=stageName('emitter-prestart',width,height)
    const emitterReq=[],emitter=await page(context,width,height,errors,emitterReq,emitterClient,base)
    await emitter.goto(`${base}/share`,{waitUntil:'networkidle0'})
    await overflow(emitter)
    g=await stats(emitter)
    ok(!g.get&&!g.watch,'EMITTER_GEOLOCATION_BEFORE_START')
    ok(observations(emitterClient).every(x=>!x.path.startsWith('/api/share/')),'EMITTER_SESSION_BEFORE_START')

    stage=stageName('emitter-start',width,height)
    await click(emitter,'INICIAR TRANSMISIÓN')
    await emitter.waitForSelector('input[aria-label="Enlace privado de espectador"]',{timeout:30000})
    let cap=await emitter.$eval('input[aria-label="Enlace privado de espectador"]',i=>new URL(i.value).hash.replace(/^#v=/,''))
    ok(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(cap),'CAPABILITY_FORMAT')
    caps.add(cap)
    g=await stats(emitter)
    ok(g.get===1&&g.watch===1,'EMITTER_GEOLOCATION_START')

    stage=stageName('viewer-preconfirm',width,height)
    const viewerReq=[],viewer=await page(context,width,height,errors,viewerReq,viewerClient,base)
    const response=await viewer.goto(`${base}/shared#v=${encodeURIComponent(cap)}`,{waitUntil:'networkidle0'})
    ok(response,'VIEWER_DOCUMENT_RESPONSE')
    const h=response.headers()
    ok(h['cache-control']?.includes('no-store')&&h['referrer-policy']==='no-referrer'&&h['content-security-policy']?.includes("frame-ancestors 'none'"),'VIEWER_SECURITY_HEADERS')
    await overflow(viewer)
    const viewerInitial=observations(viewerClient)
    const doc=viewerInitial.find(x=>x.method==='GET'&&(x.path==='/shared'||x.path==='/shared/'))
    ok(doc&&!doc.query&&!doc.urlCap,'CAPABILITY_FRAGMENT_TRANSPORT')
    ok(viewerInitial.every(x=>!x.path.startsWith('/api/share/')),'VIEWER_API_BEFORE_CONFIRMATION')
    ok(!(await viewer.$$('main[data-map-engine]')).length,'VIEWER_MAP_BEFORE_CONFIRMATION')
    const preconfirmClients=new Set([rootClient,emitterClient,viewerClient])
    const preconfirmApi=seen.filter(x=>preconfirmClients.has(x.client)&&x.path.startsWith('/api/share/'))
    ok(preconfirmApi.length>0&&preconfirmApi.every(x=>x.client===emitterClient),'PRECONFIRM_ONLY_EMITTER_API')

    stage=stageName('viewer-exchange',width,height)
    await click(viewer,'VER UBICACIÓN')
    await viewer.waitForFunction(()=>location.pathname==='/shared'&&!location.search&&!location.hash,{timeout:30000})
    await waitFor(()=>{const items=observations(viewerClient);return items.some(x=>x.path==='/api/share/viewer/exchange')&&items.filter(x=>x.method==='GET'&&(x.path.endsWith('/status')||x.path.endsWith('/points'))).length>=2},'VIEWER_TRANSPORT_READY')
    const viewerAfter=observations(viewerClient)
    const ex=viewerAfter.filter(x=>x.path==='/api/share/viewer/exchange')
    const poll=viewerAfter.filter(x=>x.method==='GET'&&(x.path.endsWith('/status')||x.path.endsWith('/points')))
    ok(ex.length===1&&ex[0].bodyCap,'VIEWER_EXCHANGE')
    ok(poll.length>=2&&poll.every(x=>x.auth),'VIEWER_BEARER_POLL')
    ok(viewerAfter.every(x=>!x.urlCap),'CAPABILITY_NOT_IN_URL')
    await memory(viewer,cap)

    stage=stageName('viewer-map',width,height)
    await viewer.waitForSelector('main[data-map-engine="maplibre"][data-location-source="shared-location"]',{timeout:30000})
    await overflow(viewer)
    a=await viewer.$eval('[aria-label="Atribución del mapa"]',n=>n.textContent||'')
    ok(a.includes('OpenFreeMap')&&a.includes('OpenStreetMap'),'SHARED_ATTRIBUTION')

    if(index===0){
      stage=stageName('rotation',width,height)
      const old=await emitter.$eval('input[aria-label="Enlace privado de espectador"]',i=>i.value)
      await click(emitter,'ROTAR ENLACE')
      await emitter.waitForFunction(v=>{const i=document.querySelector('input[aria-label="Enlace privado de espectador"]');return i?.value&&i.value!==v},{timeout:30000},old)
      cap=await emitter.$eval('input[aria-label="Enlace privado de espectador"]',i=>new URL(i.value).hash.replace(/^#v=/,''))
      caps.add(cap)
      await viewer.waitForFunction(()=>document.querySelector('main[data-viewer-state="revoked"]')&&!document.querySelector('main[data-map-engine]'),{timeout:25000,polling:250})
      ok(!(await viewer.$$('[data-ghostrail-segments]')).length,'ROTATION_GHOSTRAIL_CLEARED')

      stage=stageName('second-viewer',width,height)
      const viewer2Client=`qa-${index}-viewer-2`
      const viewer2=await page(context,width,height,errors,[],viewer2Client,base)
      await viewer2.goto(`${base}/shared#v=${encodeURIComponent(cap)}`,{waitUntil:'networkidle0'})
      await click(viewer2,'VER UBICACIÓN')
      await viewer2.waitForSelector('main[data-map-engine="maplibre"]',{timeout:30000})
      ok(observations(viewer2Client).filter(x=>x.path==='/api/share/viewer/exchange').length===1,'SECOND_VIEWER_EXCHANGE')

      stage=stageName('revocation',width,height)
      await click(emitter,'REVOCAR ENLACE')
      await viewer2.waitForFunction(()=>document.querySelector('main[data-viewer-state="revoked"]')&&!document.querySelector('main[data-map-engine]'),{timeout:25000,polling:250})
      ok(!(await viewer2.$$('[data-ghostrail-segments]')).length,'REVOCATION_GHOSTRAIL_CLEARED')
    }

    stage=stageName('final-pageerror',width,height)
    ok(!errors.length,'PAGEERROR_TOTAL_ZERO')
    result.viewports.push({width,height,pageErrors:0,horizontalOverflow:0,rootSelectorVerified:true,myDeviceVerified:true,emitterConsentVerified:true,viewerConsentVerified:true})
    await context.close()
  }

  result.gates={ROOT_SELECTOR_BEFORE_NETWORK:'PASS',ROOT_SELECTOR_BEFORE_GEOLOCATION:'PASS',ROOT_SELECTOR_BEFORE_MAP:'PASS',MY_DEVICE_EXPLICIT_SELECTION:'PASS',MY_DEVICE_SYNTHETIC_WATCH_POSITION:'PASS',MY_DEVICE_COORDINATES_NOT_TRANSMITTED:'PASS',SOURCE_SWITCH_CLEANUP:'PASS',LATE_RESPONSE_BLOCKED:'PASS',SHARE_EXPLICIT_START_REQUIRED:'PASS',SHARE_NO_GEOLOCATION_BEFORE_START:'PASS',SHARE_NO_SESSION_BEFORE_START:'PASS',VIEWER_CONFIRMATION_REQUIRED:'PASS',NO_API_BEFORE_VIEWER_CONFIRMATION:'PASS',NO_MAP_BEFORE_VIEWER_CONFIRMATION:'PASS',CAPABILITY_FRAGMENT_ONLY:'PASS',FRAGMENT_REMOVED_AFTER_EXCHANGE:'PASS',OPAQUE_BEARER_POLLING:'PASS',CAPABILITY_IN_TRANSPORT_URL:'NO',ROTATION_INVALIDATES_VIEWER:'PASS',REVOCATION_INVALIDATES_VIEWER:'PASS',GHOSTRAIL_CLEARED_ON_INVALIDATION:'PASS',PREFERS_REDUCED_MOTION:'PASS',MAP_ATTRIBUTION_PRESENT:'PASS',BROWSER_SYNTHETIC_INTEGRATION:'PASS',WORKER_SQLITE_E2E_NOT_CLAIMED:'YES',SHARED_QUERY_REJECTED:'PASS',REFERRER_POLICY_NO_REFERRER:'PASS',SHARED_CSP_STRICT:'PASS',VIEWPORTS_5:'PASS'}
  await Bun.write(output,`${JSON.stringify(result,null,2)}\n`)
  console.log('NATIVE_SHARING_CLOUDFLARE_BROWSER_QA=PASS viewports=5 synthetic=true')
} catch(error) {
  const code=error instanceof AssertionFailure?error.code:'UNEXPECTED_FAILURE'
  console.error(`BROWSER_QA_STAGE=${stage} ASSERTION_CODE=${code}`)
  process.exitCode=1
} finally {
  await browser.close()
  server.stop(true)
  ns.close()
}
