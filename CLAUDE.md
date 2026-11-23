# Mongo Studio

A MongoDB client plugin for Orca (`orca-plugin.json`, id `mongo-studio`). The README covers
features, `CONTRIBUTING.md` the human workflow; this file is what an agent needs on top of it.

## Layout

| Path | What | Runs in |
|---|---|---|
| `src/worker.ts`, `src/worker/` | Connections, secrets, the driver, SSH tunnels, jobs, the shell | Orca's plugin worker (Node), bundled to `dist/worker.mjs` |
| `src/worker/shell-thread.mjs` | The shell's script thread, with its own `bson` | Bundled to `dist/shell-thread.mjs` via `dev/shell-thread-entry.mjs` |
| `src/panel.tsx`, `src/panel/` | The sidebar panel, built from Orca components (`*-state.ts` + `*-view.tsx` per feature) | Bundled to `dist/panel.js` |
| `src/editor/` | The Mongo Shell custom editor (CodeMirror) | Loaded **as source**, one request per module |
| `src/shared/` | Pure code: model, URI/shell parsers, Extended JSON, codegen, SQL→MQL | Bundled into the worker and panel; the editor loads the modules it imports **unbundled** |
| `src/protocol.ts` | The typed contract: every `plugin.request` method and every pushed event | The only coupling between panel and worker |

A new feature usually means: types and a method in `src/protocol.ts`, a handler in `src/worker/`,
pure logic in `src/shared/` (with a `*.test.ts` beside it), and a `*-state.ts`/`*-view.tsx` pair in
`src/panel/`.

## Commands

```sh
npm run build            # bundles worker, shell thread and panel into dist/
npm run typecheck        # panel (tsconfig.json) and worker (tsconfig.worker.json), after `npm run types`
npm test                 # unit, protocol and panel tests; no database
npm run test:it          # integration tests in test/; needs the dev replica set AND the "test" profile
npm run test:enterprise  # Kerberos and LDAP; needs the "enterprise" profile
npm run check            # build + `orca plugin check` (renders the panel) + `orca plugin validate`
```

The scripts run Orca's CLI through `dev/orca.mjs` (`ORCA_CLI` overrides its path). The build and
typecheck need Orca's typings in `.orca/types` (git-ignored, `npm run types`): without them
esbuild builds a different `dist/`. CI (`.github/workflows/ci.yml`) runs typecheck, `npm test`,
the `dist/` freshness check, `npm run check` and `npm run test:it`, with the CLI from the Orca
release pinned there; bump `ORCA_VERSION`, `ORCA_DEB_SHA256` and `NODE_VERSION` together.
A pushed `vX.Y.Z` tag runs `.github/workflows/release.yml`. It checks the tag, reruns CI on it
through `workflow_call` and writes the GitHub Release from the commit subjects. Run it by hand with
a tag to backfill that tag's release.

How to start each database set is in the header of `dev/docker-compose.yml`; `/test` says which
set each level needs.

Skills: `/dev-plugin` (load, reload, inspect, screenshot), `/test` (which tests, which databases),
`/release` (cut a version).

## Rules

- **`dist/` is what Orca runs, even for the dev folder, and it is committed.** After changing
  anything under `src/` except `src/editor/`, run `npm run build` and commit `dist/` with the
  change. Never edit `dist/` by hand. Bundles are deliberately not minified.
- **An installed frame serves at most 32 requests at a time** and answers 503 past that. A wide
  module graph only fails when installed, never as a dev folder. So the panel ships as one bundle,
  and the shell editor, which loads as source, must keep its graph small: that includes every
  `src/shared/` module it reaches (today `codegen`, `js-scan`, `keys`, `shell-call`,
  `shell-vocab`, `sql-to-mql` and what they import). Adding imports to those modules grows the
  editor's frame. CodeMirror is pre-bundled into `src/editor/vendor/codemirror.js` by
  `node dev/build-codemirror.mjs`.
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
- **Never uninstall a Mongo Studio plugin key.** Two keys hold the user's real connections:
  `local.mongo-studio` (the dev folder, and also any `orca plugin install <folder>`) and
  `leobessin.mongo-studio` (the copy installed from the catalog). `orca plugin uninstall` on
  either deletes its storage and keychain secrets. `connections.export` leaves secrets out, so an
  export is not a backup of passwords, keys or passphrases. Don't `orca plugin install .` either:
  it shares the dev folder's key. To test a real install, follow `/release`.
- **Never point tests or writes at someone else's MongoDB.** Port 27017 may be held by another
  project's container (on this machine, `waplanner-mongo-dev`). The test databases are only the
  `mongo-studio-*` containers from `dev/docker-compose.yml`.
- **Worker requests can write to real databases.** `orca plugin dev request` calls the same
  handlers the panel does, against the user's saved connections. Read-only methods are fine;
  anything that writes, deletes or runs shell code needs a scratch database and the user's say-so.
- **The dev plugin runs from the main checkout**, `/home/nexus/dev/orca-mongo-studio`, kept on a
  detached HEAD; worktrees are never loaded. To try a worktree's work in Orca, detach the main
  checkout onto that commit (an unpushed snapshot made with `git commit-tree` works for
  uncommitted changes) and `orca plugin dev reload .` there. Leave its own uncommitted edits
  alone. A change to the manifest's commands, keybindings or access needs the user to approve the
  new fingerprint; don't pass `--approve` yourself.
- **Screenshots on niri:** `orca plugin shot --act`, `--scenario` and `--theme` are refused (Orca's
  window can't be hidden), so `dev/shots.sh` doesn't run here. Plain and `--editor` shots work;
  drive the panel into a view from the worker instead (see `/dev-plugin`).

## Conventions

- TypeScript, ESM, no semicolons, single quotes, 2-space indent. Match the surrounding file.
- Comments explain *why*, in full sentences; file headers say what the file is and how to run it.
- Tests:
  - `src/shared/*.test.ts` beside their module; worker unit tests in `src/worker/*.test.ts`.
  - `src/worker.test.ts`: the worker's protocol handlers over a mock host. Add protocol tests here.
  - `src/panel.test.tsx`: the main panel; `src/panel-<feature>.test.tsx` per panel area (admin,
    aggregate, collection, data, shell, tasks). Add to the matching file.
  - `test/*.test.ts`: integration tests, gated on `MONGO_STUDIO_IT=1` /
    `MONGO_STUDIO_IT_ENTERPRISE=1`.
- Commit messages: `Mongo Studio: <what changed, for a user>`; releases are
  `Mongo Studio X.Y.Z: <headline>`.
- Read-only connections are enforced by Mongo Studio, not the server: every handler that writes
  calls `writable(connectionId, action)` in `src/worker.ts` first, and the shell checks commands
  against `src/shared/read-only.ts`. A new write path must do the same. No setting may weaken
  this.
- User preferences are Orca plugin settings (`settings:own`), declared in `orca-plugin.json`
  `contributes.settings`, so they stay apart from storage and connections and Orca's Settings
  shows them too. A new one needs its type, default and `readSetting` case in
  `src/shared/settings.ts`, the same key, default and values declared in the manifest
  (`settings.test.ts` checks they match), and a control in `src/panel/settings-view.tsx`. Panel
  code reads them with `settings()` from `src/panel/settings-state.ts`: one normalized copy,
  loaded before the layout comes back and re-read from Orca when a change is announced, never
  from the announcement itself. Panel tests seed them with `mockHost({ settings })` in their
  stored form (`pageSize: 0` is "Last used").
- A confirmation that a setting can turn off is an `ask*` function (`askDelete`, `askConfirm`,
  `askDropIndex`) over an action that takes its arguments explicitly (`deleteDocuments`,
  `clearOrDrop`, `dropIndex`). When not asking, it calls the action directly and never sets the
  confirmation's state, so nothing can cancel or repeat it while it runs or linger after it
  fails; the action ignores a second press while one runs. Its button goes through
  `guard`/`aguard`, since that press can now run and fail.
