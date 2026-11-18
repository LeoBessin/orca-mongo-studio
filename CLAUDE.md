# Mongo Studio

A MongoDB client plugin for Orca (`orca-plugin.json`, id `mongo-studio`). The README covers
features and the human workflow; this file is what an agent needs on top of it.

## Layout

| Path | What | Runs in |
|---|---|---|
| `src/worker.ts`, `src/worker/` | Connections, secrets, the driver, SSH tunnels, jobs, the shell | Orca's plugin worker (Node), bundled to `dist/worker.mjs` |
| `src/worker/shell-thread.mjs` | The shell's script thread, with its own `bson` | Bundled to `dist/shell-thread.mjs` via `dev/shell-thread-entry.mjs` |
| `src/panel.tsx`, `src/panel/` | The sidebar panel, built from Orca components (`*-state.ts` + `*-view.tsx` per feature) | Bundled to `dist/panel.js` |
| `src/editor/` | The Mongo Shell custom editor (CodeMirror) | Loaded **as source**, not bundled |
| `src/shared/` | Pure code both sides use: model, URI/shell parsers, Extended JSON, codegen, SQL→MQL | Imported by both |
| `src/protocol.ts` | The typed contract: every `plugin.request` method and every pushed event | The only coupling between panel and worker |

A new feature usually means: types and a method in `src/protocol.ts`, a handler in `src/worker/`,
pure logic in `src/shared/` (with a `*.test.ts` beside it), and a `*-state.ts`/`*-view.tsx` pair in
`src/panel/`.

## Commands

```sh
npm run build        # bundles worker, shell thread and panel into dist/
npm run typecheck    # panel (tsconfig.json) and worker (tsconfig.worker.json)
npm test             # unit, protocol and panel tests; no database
npm run test:it      # integration tests in test/; needs the Docker replica set (see /test)
npm run check        # build + `orca plugin check` (renders the panel) + `orca plugin validate`
```

Skills: `/dev-plugin` (load, reload, inspect, screenshot), `/test` (which tests, which databases),
`/release` (cut a version).

## Rules

- **`dist/` is what Orca runs, even for the dev folder, and it is committed.** After changing
  anything under `src/` except `src/editor/`, run `npm run build` and commit `dist/` with the
  change. Never edit `dist/` by hand. Bundles are deliberately not minified.
- **Keep the panel bundled.** An installed plugin's frame serves at most 32 requests at a time and
  answers 503 past that; the panel's ~60-module graph only fails when installed, never as a dev
  folder. Any frame entry must stay one module or well under 32 files. The shell editor gets away
  with source because its graph is small; CodeMirror is pre-bundled into
  `src/editor/vendor/codemirror.js` by `node dev/build-codemirror.mjs`.
- **Installed plugins don't run `npm install`.** Runtime npm dependencies must be bundled into
  `dist/worker.mjs`. Native modules (`kerberos`, ssh2's `cpu-features`, `*.node`) can't be; they
  stay external and the code reports them missing. Add new externals in `dev/build.mjs` only
  for optional or native packages.
- **`npm test` rewrites `orca-plugin.json`** (`main` → `src/worker.ts`) for the run and restores it
  (`dev/with-source-main.mjs`). If a test run is killed hard, check `git diff orca-plugin.json`
  and restore `"main": "dist/worker.mjs"`.
- **Generated files:** `src/shared/orca-keys.ts` (from `ELECTRON_RUN_AS_NODE=1 node
  dev/orca-keys.mjs`, rerun after an Orca upgrade) and `src/editor/vendor/codemirror.*` (from
  `dev/build-codemirror.mjs`). Regenerate, don't hand-edit.
- **Version lives in two places:** `orca-plugin.json` and `package.json`. Bump both together.
- **Never `orca plugin uninstall local.mongo-studio`, and don't `orca plugin install .` casually.**
  A folder install uses the same storage key as the dev folder (`local.mongo-studio`); uninstalling
  it wipes the dev connections, and saved passwords and keys can't be recovered. Export first
  (`orca plugin dev request . connections.export --data '{"tasks":true}'`) or test with a GitHub
  install (`leobessin.mongo-studio`), after unloading the dev folder because their keybindings clash.
- **Screenshots on niri:** `orca plugin shot --act`, `--scenario` and `--theme` are refused (Orca's
  window can't be hidden), so `dev/shots.sh` doesn't run here. Plain and `--editor` shots work;
  drive the panel into a view from the worker instead (see `/dev-plugin`).

## Conventions

- TypeScript, ESM, no semicolons, single quotes, 2-space indent. Match the surrounding file.
- Comments explain *why*, in full sentences; file headers say what the file is and how to run it.
- Tests: `src/shared/*.test.ts` beside their module; panel tests are `src/panel-*.test.tsx` at
  the top of `src/`; worker unit tests in `src/worker/*.test.ts`; integration tests in `test/`,
  gated on `MONGO_STUDIO_IT=1` / `MONGO_STUDIO_IT_ENTERPRISE=1`.
- Commit messages: `Mongo Studio: <what changed, for a user>`; releases are
  `Mongo Studio X.Y.Z: <headline>`.
- Read-only connections are enforced by Mongo Studio, not the server: every handler that writes
  calls `writable(connectionId, action)` in `src/worker.ts` first, and the shell checks commands
  against `src/shared/read-only.ts`. A new write path must do the same.
