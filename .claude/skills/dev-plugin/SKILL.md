---
name: dev-plugin
description: Run Mongo Studio as a development plugin in Orca and look at it - build, load or reload the dev folder, call worker handlers, read logs, open the panel or shell editor and screenshot it. Use to see a change working in the real app, debug the worker or panel, or take shots.
---

# Run the dev plugin

Orca runs the bundles in `dist/` even for a dev folder, so **build first** after changing
anything under `src/` (except `src/editor/`, which loads as source). The dev plugin's key is
`local.mongo-studio`. Read the "Never uninstall" and "Worker requests" rules in `CLAUDE.md`.

## Load and reload

```sh
npm run build
orca plugin dev load .            # first time: prints an --approve fingerprint; ask the user to approve
orca plugin dev reload .          # after each build
orca plugin list                  # shows whether local.mongo-studio is enabled
orca plugin logs local.mongo-studio
```

For a long session, `npm run build:watch` in a background shell rebuilds on change; still
`orca plugin dev reload .` before looking. `orca plugin restart local.mongo-studio` stops the
worker so the next request starts it fresh (Orca also stops it when idle; the panel reconnects).
`orca plugin dev inspect local.mongo-studio` opens DevTools on its open panel or editor.

## Talk to the worker

Every method in `src/protocol.ts` can be called the way the panel does:

```sh
orca plugin dev request . connections.state --json
orca plugin dev request . tree.children --data '{"key":"conn:<id>"}' --json
```

These run against the user's real saved connections. Read-only methods (`*.state`, `*.list`,
`tree.*`, `*.poll`, `*.latest`) are fine; ask before anything that writes, deletes, imports or
runs shell code, and point it at a scratch database.

## Databases

The demo replica set and its seed are in the header of `dev/docker-compose.yml`. Before starting
it, check port 27017 (`docker ps --filter publish=27017`): if another project's container holds
it, stop and ask; don't touch that database. The user's saved connection for the demo set is
usually named "Local dev (rs0)".

## Look at it

```sh
orca plugin open local.mongo-studio
orca plugin shot local.mongo-studio --width 420 --out .orca/shots/panel.png --json
orca plugin shot local.mongo-studio --editor dev/seed.mongodb.js --width 1280 --height 800 --out .orca/shots/editor.png --json
```

Then Read the PNG. Check the JSON's `errors`, `settled` and `pendingRequests`.

**On niri (the usual session here) `--act`, `--scenario` and `--theme` are refused**: they need
Orca's window hidden or minimized, which niri can't do. So `dev/shots.sh` won't run. To show a
particular view, have the worker push it to an **open** panel. For the Shell tab with results:

1. `orca plugin open local.mongo-studio`. The worker posts `shell.results` only to panels open
   when the run finishes; a panel opened later shows its tree, not the Shell tab.
2. Start a read-only run on the demo connection (ask first if it isn't the demo set):
   `orca plugin dev request . shell.run --data '{"connectionId":"<id>","db":"shop","code":"db.orders.find().limit(20)","line":1,"column":1}' --json`
   and keep the returned `runId`.
3. Poll until it's done:
   `orca plugin dev request . shell.poll --data '{"runId":"<runId>","after":0}' --json` until
   `done` is true.
4. `orca plugin shot local.mongo-studio --width 420 --out .orca/shots/shell.png --json`

Shots go under `.orca/` (gitignored). Media for the listing lives in `media/` (cover 1600×1000,
screenshots 1280×800, WebP); how they are made is in `CONTRIBUTING.md` (Directory media).

## Panel checks without Orca's window

`npm run check` renders the panel headlessly with the scenarios in `src/panel.check.ts`
(`dist/panel.check.ts` points at it) and validates the manifest.
