// Runs an `orca` CLI command with this Node, so scripts and CI don't depend on `orca` being on
// PATH. The CLI is the Orca app's own (`app.asar.unpacked/out/cli/index.js`); ORCA_CLI points at
// another copy, which is how CI uses the one extracted from Orca's release .deb.
//   node dev/orca.mjs plugin types .
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const orcaCli = process.env.ORCA_CLI ?? '/usr/lib/orca-ide/app.asar.unpacked/out/cli/index.js'

// Returns the command's exit status. The CLI is plain Node code; ELECTRON_RUN_AS_NODE only
// matters when this script itself runs under Orca's Electron.
export function runOrca(args, cwd) {
  const run = spawnSync(process.execPath, [orcaCli, ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  if (run.error) console.error(`Cannot run the Orca CLI at ${orcaCli}: ${run.error.message}`)
  return run.status ?? 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runOrca(process.argv.slice(2)))
}
