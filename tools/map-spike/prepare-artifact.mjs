import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, extname, join } from 'node:path'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'

const kind = process.env.ARTIFACT_KIND
const outputDir = process.env.ARTIFACT_DIR
const sourceSha = process.env.SOURCE_SHA
const workflowRunId = process.env.WORKFLOW_RUN_ID
const sourceFiles = JSON.parse(process.env.SOURCE_FILES_JSON || '[]')
const commands = JSON.parse(process.env.COMMANDS_JSON || '[]')
const gates = JSON.parse(process.env.GATES_JSON || '{}')

if (!kind || !outputDir || !sourceSha || !workflowRunId || sourceFiles.length === 0) {
  throw new Error('artifact preparation inputs are incomplete')
}
if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('invalid source SHA')
if (!['renderer-spike', 'mobile-qa'].includes(kind)) throw new Error(`unsupported artifact kind: ${kind}`)

const allowedExtensions = new Set(['.json', '.txt'])
const forbiddenNames = [
  '.env', '.git', 'node_modules', 'source.zip', 'source.tar', 'archive.zip',
]
const forbiddenPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Authorization:\s*Bearer/i,
  /Cookie:\s*/i,
  /CF_Authorization/i,
  /X-Stracker-Service-Token/i,
  /STRACKER_SERVICE_TOKEN\s*[:=]/i,
  /\b(?:SID|HSID|SSID|APISID|SAPISID)=/,
  /onrender\.com/i,
  /-3[0-9]\.\d{3,}/,
  /-6[0-9]\.\d{3,}/,
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function commandVersion(command, args = ['--version']) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim().split('\n')[0]
  } catch {
    return 'unavailable'
  }
}

function collectHosts(value, hosts = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectHosts(item, hosts))
    return hosts
  }
  if (!value || typeof value !== 'object') return hosts
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'hosts' || key === 'externalHosts') && Array.isArray(child)) {
      child.forEach((host) => {
        if (typeof host === 'string' && /^[a-z0-9.-]+$/i.test(host)) hosts.add(host)
      })
    } else if (key === 'host' && typeof child === 'string' && /^[a-z0-9.-]+$/i.test(child)) {
      hosts.add(child)
    } else {
      collectHosts(child, hosts)
    }
  }
  return hosts
}

await mkdir(outputDir, { recursive: true, mode: 0o700 })
const copied = []
const aggregateHosts = new Set()
for (const source of sourceFiles) {
  const name = basename(source)
  if (!allowedExtensions.has(extname(name))) throw new Error(`artifact source extension not allowed: ${name}`)
  if (forbiddenNames.some((item) => name.includes(item))) throw new Error(`artifact source name forbidden: ${name}`)
  const data = await readFile(source)
  const text = data.toString('utf8')
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) throw new Error(`forbidden content in ${name}: ${pattern}`)
  }
  if (extname(name) === '.json') collectHosts(JSON.parse(text), aggregateHosts)
  const destination = join(outputDir, name)
  await copyFile(source, destination)
  copied.push({ name, bytes: data.byteLength, sha256: sha256(data) })
}

const maplibrePackage = JSON.parse(await readFile('node_modules/maplibre-gl/package.json', 'utf8'))
const versions = {
  node: process.version,
  bun: commandVersion('bun'),
  chrome: commandVersion(process.env.CHROME_BIN || '/usr/bin/google-chrome'),
  maplibre: maplibrePackage.version,
}
await writeFile(join(outputDir, 'commands.json'), `${JSON.stringify(commands, null, 2)}\n`, { mode: 0o600 })
await writeFile(join(outputDir, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`, { mode: 0o600 })
await writeFile(join(outputDir, 'gates.json'), `${JSON.stringify(gates, null, 2)}\n`, { mode: 0o600 })

const manifest = {
  schema: 'stracker.sanitized-validation-artifact.v1',
  artifactKind: kind,
  sourceSha,
  workflowRunId: String(workflowRunId),
  generatedAt: new Date().toISOString(),
  privateDataUsed: false,
  coordinateValuesRetained: false,
  rawLogsIncluded: false,
  sourceArchiveIncluded: false,
  hosts: [...aggregateHosts].sort(),
  files: copied,
  commandsFile: 'commands.json',
  versionsFile: 'versions.json',
  gatesFile: 'gates.json',
}
await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

const filesBeforeHashes = (await readdir(outputDir)).sort()
const hashLines = []
for (const name of filesBeforeHashes) {
  const fullPath = join(outputDir, name)
  const info = await stat(fullPath)
  if (!info.isFile()) throw new Error(`non-file artifact entry: ${name}`)
  if (!allowedExtensions.has(extname(name))) throw new Error(`non-allowlisted artifact entry: ${name}`)
  const data = await readFile(fullPath)
  hashLines.push(`${sha256(data)}  ${name}`)
}
await writeFile(join(outputDir, 'sha256sums.txt'), `${hashLines.join('\n')}\n`, { mode: 0o600 })

const finalFiles = (await readdir(outputDir)).sort()
for (const name of finalFiles) {
  if (!allowedExtensions.has(extname(name))) throw new Error(`artifact entry extension rejected: ${name}`)
  if (forbiddenNames.some((item) => name.includes(item))) throw new Error(`artifact entry rejected: ${name}`)
  const data = await readFile(join(outputDir, name), 'utf8')
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(data)) throw new Error(`security artifact scan failed in ${name}: ${pattern}`)
  }
}

console.log(`SECURITY_ARTIFACT_SCAN=PASS kind=${kind} files=${finalFiles.length}`)
console.log(`ARTIFACT_MANIFEST_SOURCE_SHA=${sourceSha}`)
