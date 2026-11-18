---
name: dev-plugin
description: Run Mongo Studio as a development plugin in Orca and look at it - build, load or reload the dev folder, call worker handlers, read logs, open the panel or shell editor and screenshot it. Use to see a change working in the real app, debug the worker or panel, or take shots.
---

# Run the dev plugin

Orca runs the bundles in `dist/` even for a dev folder, so **build first** after changing
anything under `src/` (except `src/editor/`, which loads as source).

## Load and reload

```sh
npm run build
orca plugin dev load .            # first time: prints an --approve fingerprint; ask the user to approve
orca plugin dev reload .          # after each build
orca plugin list                  # the dev plugin is local.mongo-studio
orca plugin logs local.mongo-studio
```

For a long session, `npm run build:watch` in a background shell rebuilds on change; still
`orca plugin dev reload .` before looking. `orca plugin restart local.mongo-studio` stops the
worker so the next request starts it fresh (Orca also stops it when idle; the panel reconnects).

## Talk to the worker

Every method in `src/protocol.ts` can be called the way the panel does:

```sh
orca plugin dev request . connections.state --json
orca plugin dev request . tree.children --data '{"key":"conn:<id>"}' --json
```

Read-only calls are fine. For anything that writes, use a scratch database, never the user's real
connections. Never `orca plugin uninstall local.mongo-studio`: it wipes the dev connections.

## Databases

The demo replica set (`shop`, `blog`, `analytics`, `types_zoo`):

```sh
docker compose -f dev/docker-compose.yml up -d --wait
docker compose -f dev/docker-compose.yml exec mongo mongosh --quiet /seed/seed.mongodb.js
# mongodb://localhost:27017/?replicaSet=rs0&directConnection=true
```

The user's saved connection for it is usually named "Local dev (rs0)".

## Look at it

```sh
orca plugin open local.mongo-studio
orca plugin shot local.mongo-studio --width 420 --out .orca/shots/panel.png --json
orca plugin shot local.mongo-studio --editor dev/seed.mongodb.js --width 1280 --height 800 --out .orca/shots/editor.png --json
```

Then Read the PNG. Check the JSON's `errors`, `settled` and `pendingRequests`.

**On niri (the usual session here) `--act`, `--scenario` and `--theme` are refused**: they need
Orca's window hidden or minimized, which niri can't do, and the user is usually chatting inside
Orca. So `dev/shots.sh` won't run. To show a particular view, have the worker push it instead.
For example, a shell run makes the panel open its Shell tab with the results:

```sh
orca plugin dev request . shell.run --data '<ShellRunInput JSON, see src/protocol.ts>' --json
orca plugin shot local.mongo-studio --width 420 --out .orca/shots/shell.png
```

Shots go under `.orca/` (gitignored). Media for the listing lives in `media/` (cover 1600×1000,
screenshots 1280×800, WebP).

## Panel checks without Orca's window

`npm run check` renders the panel headlessly with the scenarios in `src/panel.check.ts`
(`dist/panel.check.ts` points at it) and validates the manifest. Use `orca plugin dev inspect .`
to open DevTools on the open panel or editor.
