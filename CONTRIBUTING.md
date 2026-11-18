# Contributing to Mongo Studio

You need Node.js, Docker for the test databases, and the Orca desktop app.

```sh
npm install
npm run build             # bundle the worker, shell thread and panel into dist/
orca plugin dev load .    # load this folder into Orca (it prints an --approve fingerprint)
npm run build:watch       # rebuild on change
```

| Command | What it does |
|---|---|
| `npm run types` | Writes Orca's plugin typings into `.orca/types` (git-ignored); `typecheck` and `build` run it when needed |
| `npm run typecheck` | Type-checks the panel and the worker |
| `npm test` | Unit, protocol and panel tests (no database) |
| `npm run test:it` | Integration tests against the Docker databases |
| `npm run test:enterprise` | Kerberos and LDAP tests against MongoDB Enterprise |
| `npm run check` | Builds, renders the panel with `orca plugin check`, and validates the manifest |

Orca runs the bundles in `dist/`, even when it loads a development folder, so rebuild after
changing anything under `src/` and commit `dist/` with your change. The shell editor in
`src/editor/` loads as source. The panel is bundled because Orca loads at most 32 files at once
for an installed plugin.

The scripts run Orca's own CLI from the desktop app (`/usr/lib/orca-ide/app.asar.unpacked/out/cli/index.js`);
set `ORCA_CLI` to use another copy.

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`: typecheck,
`npm test`, a rebuild that fails if `dist/` differs from what is committed, `npm run check`, and
then the integration tests against the `test` databases. It takes the Orca CLI from the
pinned Orca release's `.deb` (`.github/actions/orca-cli`). The Kerberos and LDAP tests stay
local.

## Test databases

```sh
# Replica set with demo data (shop, blog, analytics, types_zoo)
docker compose -f dev/docker-compose.yml up -d --wait
docker compose -f dev/docker-compose.yml exec mongo mongosh --quiet /seed/seed.mongodb.js
# mongodb://localhost:27017/?replicaSet=rs0&directConnection=true

# SCRAM (27019), TLS + X.509 (27018) and an SSH bastion (2222)
dev/test-env/make-certs.sh
docker compose -f dev/docker-compose.yml --profile test up -d --wait --build
dev/test-env/setup.sh

# Kerberos and LDAP: MongoDB Enterprise (27020), an MIT KDC and OpenLDAP
docker compose -f dev/docker-compose.yml --profile enterprise up -d --wait --build
dev/test-env/setup-enterprise.sh
```

## Project layout

| Path | What |
|---|---|
| `src/panel.tsx`, `src/panel/` | The sidebar panel, built from Orca components |
| `src/worker.ts`, `src/worker/` | The worker: connections, secrets, the driver, SSH tunnels, jobs and the shell |
| `src/editor/` | The Mongo Shell editor (CodeMirror), with its Output, Code and SQL tabs |
| `src/shared/` | Code both sides use: connection model, URI parser, shell parser, Extended JSON, codegen, SQL translation |
| `src/protocol.ts` | The typed contract between the panel and the worker |
| `dist/` | The bundles Orca runs, built by `dev/build.mjs` |
| `test/` | Integration tests |
| `dev/` | Build scripts, Docker databases, seed data and test fixtures |
| `media/` | The cover and screenshots for the plugin directory |

## Directory media

The plugin directory page is built from `orca-plugin.json` (`description`, `cover`,
`screenshots`) and this repository's README. Its images live in `media/`: the cover is 1600×1000
and each screenshot 1280×800, all WebP. Check how the page renders in Orca's **Settings →
Plugins** after changing any of them, and keep an eye on the release size (`npm run check`).

- Take the shots in Orca's **default** themes (not a theme plugin), against the demo data from
  `dev/seed.mongodb.js` and connections with made-up names, never real ones. The screenshots use
  the default dark theme; the cover shows the panel in both default light and default dark.
- Each screenshot pairs two panel shots taken at `--width 640` (the Shell one pairs a 760-wide
  editor shot with a 520-wide panel shot), joined with a 1px divider and scaled to fit 1280×800.
- `dev/shots.sh` takes every panel view in both themes where Orca's window can be hidden. Where
  it can't (niri refuses `--act` and `--theme`), switch the theme in Orca's settings and drive the
  panel from the worker instead. Shooting from a copy of the folder loaded under another id (with
  its keybindings removed, so they don't clash) keeps your own saved connections out of the shots.
- The cover is `dev/cover.html`, rendered with headless Chromium; its header says which panel
  shots it reads and how to render it.

## Releasing

The Orca plugin directory lists the newest `vX.Y.Z` tag of this repository.

```sh
# raise "version" in orca-plugin.json and package.json, then:
npm run build && npm run check && npm test
git commit -am "Mongo Studio X.Y.Z"
git tag -a vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z
```

The listing's status is at https://orca.dev/plugins/leobessin/orca-mongo-studio.
