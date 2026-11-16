# Mongo Studio roadmap

The handoff for the next session. It covers where the project stands, the decisions taken, the
Orca platform facts that shape the design, and the plan for each remaining phase. The original
brief asks for the non-AI feature set of Studio 3T, built only from Orca's own components.

Last updated: 2026-11-16 (end of Phase 2).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the UI lives | **Option A.** Everything is a tab inside the one right-sidebar component panel. The only editor tab is the shell (Phase 3), a custom editor for `.mongodb.js` files. | Orca panels exist only in the right sidebar. Editor tabs are custom editors tied to a file type and drawn as plain web pages, not Orca components. A keeps the UI fully native. |
| Kerberos (GSSAPI) | Done at the end of Phase 1. | `kerberos@7` is an N-API addon that loads in Orca's Electron 43 runtime. |
| Scheduling (Phase 7) | No Orca automations. Use on-demand runs or a small scheduler in the worker. | Orca automations launch AI agents, which the no-AI rule forbids. |
| Driver | `mongodb` 7.9 in the trusted worker. | The spike proved TCP, DNS (SRV and TXT) and TLS work in the worker. |

## Status

### Done: spike

The driver works in Orca's worker (Node 24.22, Electron 43). A bundled worker (1.5 MB, built
with esbuild) also runs without `node_modules`. Results are in the Phase 0 report in the
conversation history.

### Done: Phase 1, connections and navigation

It works in Orca as a development plugin (`orca plugin dev load .`, key `local.orca-mongo-studio`).

- **Connections**
  - Create, edit, clone, delete and group connections; form mode and connection-string mode edit
    the same draft.
  - Types: standalone, replica set, sharded, `mongodb+srv`.
  - Sign-in: SCRAM-1/256, X.509, LDAP (PLAIN), Kerberos (GSSAPI), AWS IAM (keys or the SDK
    chain), OIDC (browser sign-in with PKCE, or Azure, GCP or Kubernetes identity).
  - TLS certificates as a file path (`~` is expanded, relative paths are refused) or pasted PEM.
  - SSH tunnel by password or key with passphrase. The host key is trusted on first use, and a
    changed key is refused.
  - Read preference, timeouts, default database, and other URI options passed through.
- **Test connection:** steps for DNS, SSH, TCP, TLS, handshake, sign-in and permissions, each
  with a hint when it fails or warns.
- **Tree:** connections → databases → collections, views, time-series collections, GridFS buckets,
  indexes, users and custom roles, with counts and sizes. It has a filter, favourites, a details
  pane, and an action bar under the tree in place of context menus.
- **Import and export:** connection strings, Mongo Studio JSON and Compass exports. Exports never
  include secrets, and saving goes through `files.saveAs`.
- **Palette commands:** New connection, Import connections, Export connections, Disconnect all.
- **Secrets** are kept only in `secrets:own`, and the panel only learns whether each one is set.
  When the keyring is unavailable, secrets stay in worker memory and the panel shows a warning.
- **Capabilities:** `storage:own`, `secrets:own`.

**Tests:** 84, all passing (`npm test`, `npm run test:it`, `npm run test:enterprise`).

- Unit and golden: URI parse/build, import/export, validation.
- Protocol: the worker over Orca's mock host.
- Panel: `mount` with mocked requests.
- Auth config: AWS, OIDC with a mock identity provider and PKCE, GSSAPI.
- Integration: SCRAM, X.509, TLS diagnostics, SSH (password, key, passphrase, host-key pinning,
  refused forward, TLS through SSH), and the tree over the seeded data.
- Enterprise: Kerberos (with `kinit`) and LDAP against MongoDB Enterprise, an MIT KDC and OpenLDAP.

`npm run typecheck`, `orca plugin check` and `orca plugin validate` pass.

### Open items from Phase 1

1. **Screenshots in a light theme, and of views that need clicks (blocked).** `orca plugin shot`
   only paints `--theme`, runs `--act` or replays `--scenario` when Orca's window is hidden or
   minimized: it checks `isVisible() && !isMinimized()`. niri has no minimize, and moving the
   window to another workspace still counts as visible. Options:
   - The user switches Orca to a light theme for about two minutes while the script runs.
   - Run the shot script from a session whose compositor supports minimize.
   - Accept dark-only screenshots of the opening view.

   The script is now `dev/shots.sh` in the repo, covering Phases 1 and 2 in light and dark. It
   writes to `.orca/shots/p1/` and `.orca/shots/p2/`. The only screenshot so far is the tree in dark:
   `.orca/shots/p1-tree-dark-420-top.png`. Look at each image and fix what looks off.
2. **Release packaging.** Installed plugins don't run `npm install`. Needed:
   - A script that bundles `src/worker.ts` with esbuild into `build/worker.mjs`. Mark `kerberos`
     and the driver's optional peers as external, and add a `createRequire` banner.
   - Copy the panel sources, `shared/` and `protocol.ts`.
   - Ship `kerberos` (its `lib/` plus the prebuilt N-API binary for linux-x64/arm64,
     darwin-x64/arm64 and win-x64) next to the bundle.
   - Point the manifest's `main` at the bundle in the release copy only.
   - Check that `orca plugin validate` accepts the result (it accepts a `.node` file) and that it
     loads in Orca.
3. **Not tested live:** AWS IAM and OIDC browser sign-in against real providers (no account),
   and `mongodb+srv` against a real Atlas cluster. All are covered by unit and mock tests.
4. **Known limit:** through SSH the plugin talks to the first database host only. The form warns
   about this.
5. The project isn't a git repository yet. Ask before running `git init`.

### Done: Phase 2, querying and data viewing

It works in Orca, and was checked live through the real host (`orca plugin dev request`) on the
seeded databases.

- **Collection tabs:** the Open button or Enter on a collection, view or time-series node adds a
  tab. Tab ids are a hash of the namespace (`tabIdFor`), so reopening shows the same tab. Views are
  read only. Deleting a connection closes its tabs.
- **`src/shared/shell-parse.ts`:** the shell literal parser, as designed. It returns canonical
  Extended JSON. One choice differs from JavaScript: a number written with a decimal point or an
  exponent (`3.0`, `1e3`) stays a double, so the document editor round-trips doubles. Integers in
  int32 range are Int32 and larger ones are doubles, as mongosh stores them. `new Date()` takes
  `now` from the caller, so the parser never reads the clock.
- **`src/shared/ejson-view.ts`:** BSON type names, the relaxed form, shell syntax (`toShell`, read
  back by the parser) and cell text. Golden tests compare it with `bson`'s EJSON for every type
  (`src/worker/ejson.test.ts`).
- **Query bar:** filter, projection and sort, with collation, skip and limit in a collapsible
  section. Each field shows its parse error with line and column, and nothing runs until it parses.
- **Query Builder** (`src/shared/query-builder.ts`): AND/OR groups up to 3 deep, 13 operators,
  builder → filter and filter → builder. Rows on one field merge (`{ $gte, $lt }`), and clashing
  rows use `$and`. "Add to query" sits on Tree fields.
- **Results:**
  - Paging: a cursor per query id. Reading on uses the cursor; anything else re-runs with skip.
    Cursors close after 10 minutes idle, and on disconnect or delete.
  - Count: estimated with no filter, otherwise `countDocuments` with a 10 s `maxTimeMS`, within
    skip and limit. The panel asks for the count alongside the page and drops stale answers by a
    run token. It is not also posted, since the request already answers it.
  - Table: sortable headers re-run the query with that sort, and sub-documents can be shown as
    dotted columns. Tree and JSON (relaxed or canonical) views.
- **Editing:**
  - Field editor (`src/shared/field-edit.ts`) for 18 types, with the type as a separate Select and
    a warning when saving changes it. It also adds and removes fields.
  - Paths with dots or a leading `$`, and removing an array item, read the document and write it
    back with `$replaceWith: { $literal }`, guarded by `$expr` equality with what was read.
  - The document editor works in shell syntax or canonical EJSON, and replacement keeps the `_id`.
  - Insert, clone and bulk delete. The delete confirmation names the namespace and count.
- **History and saved queries:** one storage key per connection and namespace
  (`queries.v1.<connId>.<hash>`), removed when the connection is deleted.

**Tests:** 156 pass in each of `npm test`, `npm run test:it` and `npm run test:enterprise`.
`npm run typecheck` and `npm run check` pass.

- Parser goldens, including error positions.
- EJSON goldens against `bson`.
- Field-editor conversions, Query Builder ↔ filter, and page shrinking with Orca's size measure.
- 14 panel tests for the collection tab (`src/panel-collection.test.tsx`).
- Live tests on the dev replica set (`test/query.test.ts`):
  - Paging all 20,000 orders, and a 500-document page that fits Orca's limits.
  - Counts, a view (read only), a server error, and history.
  - Every type in a scratch copy of `types_zoo.everything` read, saved back unchanged, then
    changed, plus nested and dotted paths, field removal, replace, insert and bulk delete.

### Open items from Phase 2

1. **Screenshots (blocked, as in Phase 1).** `dev/shots.sh` now holds the whole list for Phase 1
   and Phase 2, in light and dark. It needs Orca's window hidden for about two minutes. Then look
   at each image and fix what looks off. In particular, check:
   - How the Table handles many columns in a 420 px panel.
   - The query bar's two-column row.
   - The Query Builder's rows.
2. The document editor is a plain `Textarea`, with no highlighting. The custom editor of Phase 3
   is where real editing goes.
3. A document too big for one request (1 MiB, or 10,000 values in canonical EJSON) can be viewed
   but not edited. The editor says to use the shell, which arrives in Phase 3.

## Orca platform facts to remember

- The worker is a long-lived Node process shared by every request, and Orca stops it when idle.
  Keep no process-wide state, such as `dns.setServers`.
- Limits: `panels.post` takes at most 256 KiB and 200 posts per 10 s. A `plugin.request` times
  out after 120 s at most (default 30 s). So results come in pages the panel asks for, posts carry
  progress only, and long jobs run with job ids.
- **Size measure (from the host code):** a `plugin.request` answer is refused (`too_large`) past
  1 MiB, past **10,000 objects and arrays**, or deeper than 100 levels. The cost model:
  - strings count their UTF-8 bytes; numbers 8; null and booleans 1;
  - each array 8, plus 4 per item; each object key 4 plus its bytes.

  Canonical EJSON makes every number an object, so the object count runs out first: about 316
  whole orders per page. `src/shared/host-size.ts` mirrors the measure, and pages and edits are
  budgeted with it. Inputs most likely follow the same rule. A storage value is capped at 256 KiB.
- **Tab values and keys:** keep them to letters, digits and `-`. With `:` or `/` in a `Tab` value,
  typed input in that tab stopped reaching the panel's atoms in tests.
- Orca's components have **no** context menus, modal dialogs or drag and drop, and **Table cells
  are text only**. The workarounds:
  - Actions on the current selection in a toolbar.
  - Inline confirmation callouts for destructive actions.
  - An "Add to query" action instead of dragging fields.
  - Editing in forms and the Tree view.
- Finders in `orca/testing` don't see closed `Collapsible`s or unselected tabs.
- **Test loader:** a test file may import npm packages only through modules reached from
  `main`. A test that imports `src/worker/*.ts` directly must `import '../worker'` first.
- A components panel may import relative modules (`src/shared`, `src/panel`), but no npm package.
- Commands can't open the panel. They post `ui.navigate`, which an open panel acts on.
- `files.saveAs` needs a press. Prepare the data before the press (see `refreshExport`).
- Approval: new capabilities or changed commands need `orca plugin dev load . --approve <fp>`.
  Code edits reload without asking again.
- The CLI on this machine: `ELECTRON_RUN_AS_NODE=1 node /usr/lib/orca-ide/app.asar.unpacked/out/cli/index.js`.
  The npm scripts already use it.
- Test environment quirks:
  - The Enterprise image needs `libsasl2-modules-gssapi-mit` (`dev/test-env/enterprise/Dockerfile`).
  - The client `krb5.conf` needs `qualify_shortname = ""`.
  - The X.509 client certificate's O must differ from the server's.
  - Alpine sshd needs its default `AllowTcpForwarding no` removed.

## Local databases (`dev/docker-compose.yml`)

| Profile | Containers | Ports |
|---|---|---|
| default | `mongo-studio-dev`: rs0 replica set with seeded `shop`, `blog`, `analytics`, `types_zoo` | 27017 |
| `test` | `mongo-studio-auth` (SCRAM), `mongo-studio-tls` (TLS + X.509), `mongo-studio-sshd` | 27019, 27018, 2222 |
| `enterprise` | `mongo-studio-enterprise`, `mongo-studio-kdc`, `mongo-studio-ldap` | 27020, 8888 |

The setup commands are in the README. The seed is deterministic: `dev/seed.mongodb.js`, run
with mongosh. It covers every BSON type, views, TTL, capped, clustered and time-series
collections, every index kind, GridFS, users and roles.

## Later phases (from the brief)

- **Phase 3, shell and code (next; ask before starting)**
  - The IntelliShell equivalent: the one custom editor (`.mongodb.js`, created from Orca's
    new-file menu). It bundles a code editor library and uses only `--orca-*` colour variables.
    It offers autocomplete for collections, sampled fields, operators and shell methods, and runs
    the selection, the current statement or the whole script. Results appear in the panel's
    Table/Tree/JSON views.
  - Code generation for Node, Python, Java, C#, PHP, Ruby and mongosh, with golden tests.
  - SQL → MQL translation: SELECT, WHERE, GROUP BY, ORDER BY, and JOIN to `$lookup`. It is
    deterministic, with golden tests.
- **Phase 4, aggregation:** a stage-by-stage builder that can add, reorder, enable, disable and
  duplicate stages, with a preview of each stage's input and output. Explain plans, visual and
  raw, for finds and aggregations. Create a view from a pipeline.
- **Phase 5, admin and schema**
  - Index manager: every index kind, hide/unhide, sizes and usage.
  - Collection operations: capped, time-series, clustered and validated collections; rename,
    drop, clear, stats, and a validation-rule editor.
  - User and role manager.
  - Server status, current operations and kill op, and a profiler viewer.
  - Schema Explorer: sampling, type distribution, histograms, and export as JSON Schema or a
    `$jsonSchema` validator.
- **Phase 6, data movement**
  - Import from JSON, mongoexport, CSV (with mapping and type inference) and BSON/mongodump.
  - Export to JSON, CSV, BSON or another collection.
  - Copy and paste between connections.
  - Compare and sync two collections.
  - GridFS browser.
  - Files come in by pasting or reading a path in the worker, and go out through `files.saveAs`
    (64 MiB maximum) or a path written by the worker.
- **Phase 7, workflow:** saved tasks run on demand (not Orca automations). A read-only flag per
  connection, enforced in the worker. Destructive confirmations show the namespace and document
  count. Keybindings must not clash with Orca's.

## Working agreements

- When the platform and the brief disagree, follow the platform and tell the user.
- Look at every screenshot and fix visual inconsistencies.
- Run `npm run typecheck`, the three test suites, and `npm run check` before reporting a phase.
- Stop at the end of each phase and report before going on.
