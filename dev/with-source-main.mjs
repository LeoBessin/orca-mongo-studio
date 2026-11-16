// Runs an `orca plugin` command with the manifest's `main` pointed at src/worker.ts, then puts it
// back. `orca plugin test` lets only files reached from `main` import npm packages, and `main` is
// the bundle (dist/worker.mjs), so tests that import src/worker/ need the source as `main`.
//   node dev/with-source-main.mjs plugin test .
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'orca-plugin.json')
const cli = process.env.ORCA_CLI ?? '/usr/lib/orca-ide/app.asar.unpacked/out/cli/index.js'

const original = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(original)
manifest.main = 'src/worker.ts'
const restore = () => writeFileSync(manifestPath, original)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { restore(); process.exit(130) })

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
let status = 1
try {
  const run = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  status = run.status ?? 1
} finally {
  restore()
}
process.exit(status)
