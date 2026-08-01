import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../../package.json', import.meta.url)
const packageJson = JSON.parse(await readFile(path, 'utf8'))

packageJson.dependencies.next = '^16.2.11'
packageJson.dependencies['next-auth'] = '^4.24.15'
packageJson.dependencies.sharp = '^0.35.3'
packageJson.devDependencies['eslint-config-next'] = '^16.2.11'
packageJson.overrides = {
  ...(packageJson.overrides || {}),
  'brace-expansion': '1.1.17',
  'js-yaml': '4.3.0',
  postcss: '8.5.12',
  sharp: '0.35.3',
}

await writeFile(path, `${JSON.stringify(packageJson, null, 2)}\n`)
