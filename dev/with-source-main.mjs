// Runs an `orca plugin` command with the manifest's `main` pointed at src/worker.ts, then puts it
// back. `orca plugin test` lets only files reached from `main` import npm packages, and `main` is
// the bundle (dist/worker.mjs), so tests that import src/worker/ need the source as `main`.
//   node dev/with-source-main.mjs plugin test .
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOrca } from './orca.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'orca-plugin.json')

const original = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(original)
manifest.main = 'src/worker.ts'
const restore = () => writeFileSync(manifestPath, original)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { restore(); process.exit(130) })

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
let status = 1
try {
  status = runOrca(process.argv.slice(2), root)
} finally {
  restore()
}
process.exit(status)
