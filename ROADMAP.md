# Mongo Studio roadmap

The handoff for the next session. It covers where the project stands, the decisions taken, the
Orca platform facts that shape the design, and the plan for each remaining phase. The original
brief asks for the non-AI feature set of Studio 3T, built only from Orca's own components.

Last updated: 2026-11-16 (end of Phase 6).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the UI lives | **Option A.** Everything is a tab inside the one right-sidebar component panel. The only editor tab is the shell (Phase 3), a custom editor for `.mongodb.js` files. | Orca panels exist only in the right sidebar. Editor tabs are custom editors tied to a file type and drawn as plain web pages, not Orca components. A keeps the UI fully native. |
| Kerberos (GSSAPI) | Done at the end of Phase 1. | `kerberos@7` is an N-API addon that loads in Orca's Electron 43 runtime. |
| Scheduling (Phase 7) | No Orca automations. Use on-demand runs or a small scheduler in the worker. | Orca automations launch AI agents, which the no-AI rule forbids. |
| Driver | `mongodb` 7.9 in the trusted worker. | The spike proved TCP, DNS (SRV and TXT) and TLS work in the worker. |
| Shell execution | Scripts run synchronously in a `worker_thread` (`src/worker/shell-thread.mjs`) inside a `vm` context; each database call blocks the thread (`Atomics.wait` + `receiveMessageOnPort`) while the worker's main thread runs it on the pooled MongoClient. | Legacy-shell semantics (`findOne().x`, `forEach`, loops) without mongosh's async rewriter, and Stop can terminate a runaway loop. Results reuse the panel's paging. |
| Shell target | A header comment in the file: `// @mongo-studio connection="<name>" db="<db>"`. | Editors never learn their file path, so the file has to carry its own target. Names, not ids, so a script works on another machine with a connection of the same name. |
| Shell results | Shown in the panel's Shell tab, which is a collection tab backed by `shell.page` instead of `query.page`. Only the newest run's results stay open. | Reuses Table/Tree/JSON and paging; bounds open cursors. |
| Aggregation tabs | A collection tab with `agg` set (`agg-<hash>` ids, next to `coll-<hash>`). Stages are a Table plus an editor for the selected stage; move, toggle, duplicate and remove are buttons. | Reuses the results views, paging and counting. Orca has no drag and drop, and a Table + one editor fits a 420 px panel better than a card per stage. |
| Stage preview | `agg.preview` runs the enabled stages before the selected one (input) and with it (output), each + `$limit: size + 1`, in parallel, each half the page budget. Bodies are previewed on selection, structural changes and Ctrl+Enter, not per keystroke. | No timers in the panel; a request per keystroke would flood the worker. |
| Writes (`$out`, `$merge`) | Never previewed, counted, re-run for a page (`agg.page` refuses unless it reads on from the open cursor) or explained with execution (forced to queryPlanner). Run asks first, naming the target. | A write must happen exactly once, when the person asks. |
| Explain | The worker runs `explain` (inner `maxTimeMS` 120 s), serializes the answer as relaxed EJSON, and `src/shared/explain.ts` reads it into a summary and a stage tree; the raw text goes as one string (cut at 600 K chars). | One string costs one object in Orca's measure; the summary is small. The reader is pure, so it is tested on fixtures of every shape. |
| Admin UI | Five tab kinds (Manage collection, Database, Users and roles, Server, Schema) in one `adminTabs` atom, in the same `tabOrder` as collection tabs; ids `adm-<kind>-<hash>`. Sections are Collapsibles. | One tab per object keeps state per object; Collapsibles keep a 420 px panel short. |
| Live server status | The panel loops `server.status` with `waitMs: 5000`; the worker waits (abortable) before reading. A token ends an old loop; a failure turns live off with a notice. | Panels have no timers. Same idea as `shell.poll`. |
| Schema report | `schema.analyze` answers the report as one JSON string; the panel parses it. Analysis is pure (`src/shared/schema.ts`) on canonical EJSON, histograms from a seeded reservoir of 5,000 values per field. | A report has many small objects; one string costs one object in Orca's measure. |
| Destructive admin actions | Inline confirmations naming namespace and count (drop and clear collection, drop index, drop user/role, kill op); dropping a database needs its name typed. System databases are refused in the worker. | No modal dialogs in Orca. |
| Data jobs | Imports, exports, copies, compares, syncs and GridFS transfers are worker jobs (`src/worker/jobs.ts`): the start request answers a job id, `job.poll` waits (up to 20 s) for the next version, `job.cancel` aborts. | Jobs outlast the 120 s request limit, and the panel has no timers. |
| Files in and out | In: pasted text sent in 200 K-character pieces (`import.upload`), or a path the worker streams. Out: a download kept in the worker (64 MiB, the save dialog's limit) and read by the panel in 600 KB base64 pieces (`job.read`), or a path the worker writes as `.part` and renames. | Orca has no open dialog; requests and answers stop at 1 MiB; one string is cheap in Orca's measure. |
| Copy and paste | A panel clipboard (collection, database or selected documents); Paste opens the Export tab set to "Another collection". | No system clipboard API in panels; one copy engine for export, copy and paste. |
| Compare | Two passes in batches by `_id` (A's documents looked up in B, then B's ids in A); equality on canonical Extended JSON. Sync makes the same passes and writes. | Memory stays small; no BSON ordering to reproduce for a merge join. |
| CodeMirror | Bundled once into `src/editor/vendor/codemirror.js` by `dev/build-codemirror.mjs`; the `.d.ts` re-exports the npm typings. | Frames import only relative files, and the build step stays out of everyday work. |

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
5. Git: public at https://github.com/LeoBessin/orca-mongo-studio (MIT), branch `main`.

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
2. The document editor is a plain `Textarea`, with no highlighting. The shell (Phase 3) is the
   place for heavier editing; the panel cannot host CodeMirror.
3. A document too big for one request (1 MiB, or 10,000 values in canonical EJSON) can be viewed
   but not edited in the panel. The editor says to use the shell, which now exists (Phase 3).

### Done: Phase 3, shell and code

It works in Orca as a development plugin, checked live through the real host (the script thread
runs in Orca's worker process) and in headless Chromium with the real editor bundle against the
live worker (`orca plugin dev request`): runs, errors, autocomplete, Code and SQL tabs.

- **Mongo Shell editor** (`src/editor/`, custom editor for `.mongodb.js`, new file from the + menu):
  - CodeMirror 6 with JavaScript highlighting, styled from `--orca-*` variables only, and Orca's
    editor typography (`editor.readTypography` and its change event).
  - Connection picker and database field (with a list of databases) that rewrite the header line.
  - Run the selection or the statement under the cursor (Ctrl+Enter), the whole script
    (Ctrl+Shift+Enter), Stop, Clear variables. Errors underline their line.
  - Output pane with the line of each value; short documents one per line.
  - Text sync through `orca.document.session` with a line-level three-way merge for outside writes.
- **Statements** (`src/shared/js-scan.ts`, `shell-prepare.ts`): a tolerant JS scanner splits
  top-level statements by JavaScript's own newline rules; `use x`/`show x`/`it` become calls;
  `const`/`let` become assignments so a rerun never says "already declared" (columns kept).
- **Shell runtime** (`src/worker/shell.ts`, `shell-thread.mjs`): one thread per editor, kept 30
  minutes idle; `db` and collection proxies, find/aggregate cursors (lazy, with sort/limit/…),
  CRUD, bulkWrite, indexes, commands, `getSiblingDB`, BSON constructors callable without `new`.
  Arguments cross as BSON bytes, so every type stays exact. A statement's unread cursor is opened
  by the main thread for paging and keeps its find/aggregate as an Operation.
- **Autocomplete** (`src/editor/complete.ts`, `src/shared/shell-vocab.ts`): collections, fields
  sampled with `$sample` (100 docs, cached 60 s), db/collection/cursor methods, and operators by
  place (query, update, stage, accumulator, expression, projection), quoted keys and `'$field'`
  paths.
- **Code generation** (`src/shared/codegen.ts`): mongosh, Node.js, Python, Java, C#, PHP, Ruby for
  finds and aggregates, every BSON type mapped exactly. Node, Python and Java goldens were also
  checked against the real encoders (bson, PyMongo 4.20, Java bson 5.2); C#, PHP and Ruby only by
  reading the drivers' sources (no toolchains here).
- **SQL → MQL** (`src/shared/sql-to-mql.ts`): SELECT with WHERE, GROUP BY/HAVING, aggregates,
  DISTINCT, ORDER BY, LIMIT/OFFSET, INNER/LEFT JOIN → `$lookup` + `$unwind`; refuses what it can't
  translate faithfully, with the position. Notes explain SQL/MongoDB differences.
- **Panel:** Shell tab (`src/panel/shell-*.ts(x)`), "Open as query", Code section on collection
  tabs and shell results, palette command "Mongo Studio: Show shell results".

**Tests:** 283 pass in each of `npm test`, `npm run test:it` and `npm run test:enterprise`;
`npm run typecheck` and `npm run check` pass.

- Scanner, statement splitting, completion places, statement → operation (`js-scan.test.ts`).
- Statement preparation, header, merge, vocabulary (`shell-prepare.test.ts`).
- Code generation goldens for every language (`codegen.test.ts`), SQL goldens and errors
  (`sql-to-mql.test.ts`, about 110 cases).
- Panel Shell tab (`panel-shell.test.tsx`).
- Live shell on the dev replica set (`test/shell.test.ts`): ordering, sync semantics, variables
  across runs, await, cursor paging and its operation, every BSON constructor round-trip, errors
  with line and server code, stopping an endless loop, autocomplete names.

### Done: Phase 4, aggregation and explain

Checked live through the real host (`orca plugin dev request`: `agg.preview`, `agg.explain` with the
SBE plan of a `$group`).

- **Aggregation tab** (`src/panel/aggregate-*.ts(x)`, `src/shared/pipeline.ts`): opened from the
  tree ("Aggregate"), a collection tab (layers button: the query bar becomes `$match`/`$sort`/
  `$skip`/`$limit`/`$project`), or a shell aggregate result. Stage table, add after the selected
  stage (30 operators with templates), up/down, on/off, duplicate, remove; the selected stage's
  editor (shell syntax, errors with line and column) with its input/output preview (5–100 docs);
  text mode for the whole pipeline; Run with paging and `$count` counting; allow disk use;
  `$out`/`$merge` confirmation; create a view (tree refreshed, "Open the view"); saved pipelines
  (`pipelines.v1.<connId>.<hash>`, removed with the connection); Code section.
- **Worker** (`src/worker/aggregate.ts`, `query.ts`): `QuerySessions` now pages any cursor
  (`read()`), with `pageAggregate` and `countAggregate`; previews, explain for finds and
  pipelines, `createView` (checks the name, refuses a taken name and writes), saved pipelines.
- **Explain** (`src/shared/explain.ts`, `src/panel/explain-*.ts(x)`): queryPlanner,
  executionStats, allPlansExecution. Classic stages; SBE (`winningPlan.queryPlan`, stats matched by
  `planNodeId`, the outermost SBE stage of a node gives its output); `stages` with `$cursor`;
  sharded finds (`SHARD_MERGE` + `shards`) and pipelines (`shards: {}` + `splitPipeline`). Summary,
  warnings (collection scan, in-memory sort, disk spill, examined/returned ≥ 10 past 1,000 docs,
  failed run), tree with per-stage numbers and details, raw JSON. The verbosity choice persists.
- **Shell:** `cursor.explain(v)`, `db.c.explain(v).find(…)` (shows the plan; `.finish()` returns
  it), `.aggregate`, `.count`, `.distinct`; `explain` in autocomplete.

**Tests:** 330 pass in each of `npm test`, `npm run test:it` and `npm run test:enterprise`;
`npm run typecheck` and `npm run check` pass.

- Stage model, text round trip, previews and write detection (`pipeline.test.ts`).
- Explain reader on classic, SBE, `$cursor` pipelines, sharded finds and pipelines, plan-only,
  `_id` lookups, failed runs (`explain.test.ts`).
- 13 panel tests (`panel-aggregate.test.tsx`): building, moving and toggling stages, broken stages,
  run/page/count, `$out` confirmation, text mode, views, saved pipelines, opening from a
  collection tab and from the shell, explain on both tab kinds.
- Live on the dev replica set (`test/aggregate.test.ts`): previews (size limit, refused writes),
  paging with `$skip`, counts, `$out` once, views, saved pipelines, explain of indexed and
  unindexed finds and of pushed-down and `$cursor` pipelines, shell explain.

### Open items from Phase 4

1. **Screenshots (blocked, as before).** `dev/shots.sh` now has a Phase 4 section (aggregation
   tab, preview input, results, text mode, `$out` confirmation, explain visual and raw, create
   view) writing to `.orca/shots/p4/`. Its `"replace":true` on typed text is what the test kit
   takes; check that `plugin shot --act` takes it too. Look at the stage Table and the Preview
   toolbar at 420 px in particular.
2. Explain is not tested against a real sharded cluster (fixtures follow the documented shapes).
3. The preview reads the whole input of the stages before the selected one; Compass offers a
   "sample the source first" mode. Worth adding if previews on big collections are slow.
4. Saved pipelines and query history are separate stores; Phase 7's saved tasks may unify them.

### Done: Phase 5, administration and schema

Checked live through the real host (`orca plugin dev request`: `admin.indexes`, `admin.collection`,
`schema.analyze` on 5,000 orders in 160 ms, `server.status` with `waitMs`, `server.ops`,
`users.list`, `profiler.status`).

- **Manage tab** (`src/panel/manage-*`, `src/worker/admin.ts`): statistics and options; index
  manager (`src/shared/index-spec.ts`: every key kind, unique, sparse, hidden, TTL, partial,
  collation, wildcard projection, text weights/languages, 2d options; checks before the server; the
  mongosh command), hide/unhide, TTL change (`collMod`), drop; builds in progress from
  `$currentOp`; validation editor with "Check documents" (`countDocuments({ $nor: [validator] })`)
  and "From the schema"; rename (other database, drop target), convert to capped, clear, drop.
- **Database tab** (`src/panel/database-*`): statistics, collections (Enter opens one), create a
  plain, capped, time-series or clustered collection with validator and collation (or a new
  database with its first collection), profiler level/slowms/sampleRate and entries, drop with the
  name typed.
- **Users and roles tab** (`src/panel/users-*`, `src/worker/users.ts`): create/update/drop users
  (password, roles, custom data, mechanisms; `$external` users without password) and roles
  (privileges in shell syntax, inherited roles).
- **Server tab** (`src/panel/server-*`, `src/worker/server.ts`): serverStatus sections, rates,
  replica set members and lag, live mode, current operations (`$currentOp`, falling back to own
  operations without `inprog`), killOp with confirmation.
- **Schema Explorer** (`src/panel/schema-*`, `src/shared/schema.ts`, `src/worker/schema.ts`):
  `$sample` after an optional filter, field tree with types and presence (arrays as `[]`), number
  and date histograms, top strings, lengths; export as `$jsonSchema` (to the Manage tab) or
  JSON Schema 2020-12, Save as file.
- Entry points: tree action bar (connection: Server, New database; database: Manage, Users;
  collection/view: Manage, Schema; Indexes/index: Manage indexes; Users/Roles nodes), and the
  collection tab's toolbar (Manage, Schema). Deleting a connection closes its admin tabs; dropping
  or renaming closes the tabs of that namespace.

**Tests:** 374 pass in each of `npm test`, `npm run test:it` and `npm run test:enterprise`;
`npm run typecheck` and `npm run check` pass.

- Schema analysis, histograms (including Int64 extremes and far dates), JSON Schema in both
  flavours (`schema.test.ts`); the index form and its errors (`index-spec.test.ts`).
- 19 panel tests (`panel-admin.test.tsx`): every tab from the tree, index create/hide/TTL/drop,
  validation load/check/save, clear and drop confirmations, rename, create capped and time-series
  collections, new database, profiler, drop database by name, users and roles, server rates,
  kill with confirmation, live refresh stopping on failure, schema export to a validator, no
  Orca warnings with every section open.
- Live (`test/admin.test.ts`): every index kind created, hidden, TTL changed and dropped;
  every collection kind created; validation check and set; rename, clear, convert to capped, drop;
  profiler entries; users and roles round trip (the new user signs in); server status, a slow
  `$where` find found in current operations and killed; schema samples.

### Open items from Phase 5

1. **Screenshots (blocked, as before).** `dev/shots.sh` has a Phase 5 section writing to
   `.orca/shots/p5/` (manage, index details, new index, validation check, drop confirmation,
   database, create collection, profiler, users, user form, server, schema, schema export). Look in
   particular at the index Table and the New index rows at 420 px, the server sections Grid, and
   the histogram text bars.
2. Not tested against a sharded cluster or Atlas: `$currentOp` on mongos (opids like
   `shard:123` are sent back as given), profiler on mongos (the server refuses levels there; the
   error is shown), and `$indexStats` per shard.
3. The profiler's slow threshold and sample rate are server-wide (MongoDB's rule); the tab says so.
4. Index builds started elsewhere show from `$currentOp`; there is no progress post, so the person
   refreshes. A build that outlasts the 2-minute request timeout keeps running and says so.
5. User editing doesn't cover authentication restrictions (`authenticationRestrictions`) or
   password digestion options; roles don't cover `authenticationRestrictions` either.

### Done: Phase 6, data movement

Checked live through the real host (`orca plugin dev request`: a CSV export to a path, its import
preview with inferred types, `gridfs.list`, a BSON download read back with `job.read`).

- **Jobs** (`src/worker/jobs.ts`): job registry with versioned polling, cancel, the first 50 errors;
  staged uploads (64 MiB, 30 minutes); `Outbox` (download, 64 MiB) and `FileSink` (`.part`, then
  rename; refuses to overwrite unless asked). Batched writes (`src/worker/writer.ts`): insert,
  replace by `_id`, merge by `_id`, unordered unless "stop at the first error", errors tied to
  record numbers.
- **Import** (`src/worker/import.ts`, `src/panel/import-*`): JSON split by `src/shared/json-records.ts`
  (array, lines, or one after another; relaxed or canonical), CSV/TSV (`src/shared/csv.ts`:
  incremental reader, type inference from 1,000 rows, mongoimport typed headers, dotted fields),
  BSON files and dump folders (`.gz` too) with `.metadata.json` (indexes, options, views). Preview
  with the column mapping; drop first (confirmed with the count).
- **Export and copy** (`src/worker/export.ts`, `src/panel/export-*`): a find, a pipeline (writes
  refused) or a database; JSON, CSV (sampled fields, ordered; others as Extended JSON), BSON with
  metadata; to the save dialog or a path (a folder for a database); into a collection on any
  connection, with indexes and creation options, views recreated, drop first (confirmed).
- **Copy and paste**: tree Copy on a collection or database, "Copy" on selected rows; Paste on a
  connection (database), database or collection.
- **Compare and sync** (`src/worker/compare.ts`, `src/shared/compare.ts`, `src/panel/compare-*`):
  filter, fields left out, field order; counts and id lists (capped by count and size), a pair's
  field differences; sync with insert/replace/delete, confirmed with counts.
- **GridFS** (`src/worker/gridfs.ts`, `src/panel/gridfs-*`): files paged and filtered, details,
  chunk check, text preview (64 KB), download, upload (content type in `metadata.contentType`),
  rename, delete (confirmed).
- Entry points: tree action bar (collection: Import, Export, Compare, Copy, Paste; database:
  Import, Export, Copy, Paste; connection: Paste; bucket: Browse files), collection tab toolbar
  (Export with its query, Import, Compare), result rows (Copy), aggregation tab (Export).

**Tests:** 421 pass in each of `npm test`, `npm run test:it` and `npm run test:enterprise`;
`npm run typecheck` and `npm run check` pass.

- CSV reading in pieces, inference, cells, typed headers, mapping problems, writing and reading
  back (`csv.test.ts`); JSON splitting in pieces (`json-records.test.ts`); document comparison and
  base64 (`compare.test.ts`).
- 11 panel tests (`panel-data.test.tsx`): pasted CSV with mapping, drop confirmation, export to
  the save dialog (bytes checked), CSV columns, database to a folder, paste of a collection to
  another connection with drop confirmation, paste of selected documents, compare/diff/sync,
  GridFS end to end, a failed job.
- Live (`test/data.test.ts`): JSON exports; every BSON type through BSON and canonical JSON files;
  CSV export/import with types; import modes and errors; a database to a dump folder and back
  (indexes, validator, view); reading real `mongodump --gzip` and `mongoexport` (JSON and CSV)
  output from the container; copies across connections (indexes, options, time series, pasted ids);
  compare, diff and sync; GridFS; cancel leaves no file.

### Open items from Phase 6

1. **Screenshots (blocked, as before).** `dev/shots.sh` has a Phase 6 section writing to
   `.orca/shots/p6/` (import, CSV mapping, dump folder, export JSON/CSV/done, copy, database,
   paste, compare, sync, GridFS, upload). Look in particular at the import Columns table, the
   export format RadioGroup with descriptions, and the compare results at 420 px.
2. Not read: mongodump `--archive`, mongoimport `binary()`/`date(layout)` types (inferred
   instead), CSV with custom date layouts. Compare matches by `_id` only.
3. Checked by hand both ways (not in the test suite: it needs `docker cp` into the container):
   `mongorestore` of a dump folder written by Export restores every `shop` collection with its
   indexes and both views; `mongoimport` reads our canonical JSON of `types_zoo.everything`
   identically, and our CSV of 20,000 orders.
4. A database copy writes collections one after another; a big database would gain from a few in
   parallel.
5. Phase 7 could reuse jobs for saved tasks (an export or copy saved with its options and run on
   demand).

### Open items from Phase 3

1. **Screenshots (blocked, as before).** Editor shots work only without `--act` while Orca's
   window is visible; the opening view is in `.orca/shots/p3/editor-open.png`. Add the editor and
   the Shell tab to `dev/shots.sh` in light and dark.
2. **Release packaging** now also needs `src/worker/shell-thread.mjs` (it loads `bson` by the
   absolute path the worker passes; in a bundle, give it its own bundled `bson`) and the vendored
   CodeMirror file, which is already self-contained.
3. **`__proto__` keys:** `shellKey` in `ejson-view.ts` writes `__proto__: v`, which a JavaScript
   object literal (and probably `parseShell`, which assigns keys with `obj[key] =`) reads as a
   prototype, losing the field. Needs a computed key (`['__proto__']`) and own-property writes in
   the parser.
4. **Not covered by the shell yet:** `rs.*`, `sh.*`, `load()`, change streams, sessions and
   transactions. (`explain()` came with Phase 4.)
5. The editor's UI is tested in a scratch harness (headless Chromium + `playwright-core` + a stub
   `window.orca` proxying to `orca plugin dev request`), not in the repo. Worth adding to `dev/` if
   the editor grows.

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
- Finders in `orca/testing` don't see closed `Collapsible`s or unselected tabs. Collapsibles and
  Callout titles match by `label`; a `Progress` bar's text is its `label`, not `text`.
- **A `Select` option whose value is `''` makes Orca drop the Select** (it isn't drawn). Use a
  sentinel value (`'any'`, `'default'`) or `placeholder` with no matching option.
- **Test loader:** a test file may import npm packages only through modules reached from
  `main`. A test that imports `src/worker/*.ts` directly must `import '../worker'` first.
- A components panel may import relative modules (`src/shared`, `src/panel`), but no npm package.
- Commands can't open the panel. They post `ui.navigate`, which an open panel acts on.
- `files.saveAs` needs a press. Prepare the data before the press (see `refreshExport`).
- Approval: new capabilities or changed commands need `orca plugin dev load . --approve <fp>`.
  Code edits reload without asking again.
- The CLI on this machine: `ELECTRON_RUN_AS_NODE=1 node /usr/lib/orca-ide/app.asar.unpacked/out/cli/index.js`.
  The npm scripts already use it.
- **Worker threads:** `worker_threads` work in the plugin worker, but Orca's module hooks apply
  inside them too: a thread file may not import npm packages by name. Load them by absolute path
  (`createRequire(import.meta.url)(pathFromWorker)`), and write the thread in plain `.mjs` (only
  the worker's own graph is transpiled).
- **Answers must be plain JSON:** a field set to `undefined` makes Orca refuse the whole answer
  ("answered with a non-JSON value"). Strip them before returning.
- **Custom editors:** the entry `.ts` is transpiled and may import relative files only; the
  editor never learns its file path; `orca.plugin.request` from an editor has a stable
  `context.panel.id` while it stays open (used as the shell session key).
- **Test runner:** a test that polls a worker handler that answers at once must not loop on it
  without awaiting a timer: the promise-only loop starves the worker thread's messages.
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

- **Phase 7, workflow (next; ask before starting):** saved tasks run on demand (not Orca automations). A read-only flag per
  connection, enforced in the worker. Destructive confirmations show the namespace and document
  count. Keybindings must not clash with Orca's.

## Working agreements

- When the platform and the brief disagree, follow the platform and tell the user.
- Look at every screenshot and fix visual inconsistencies.
- Run `npm run typecheck`, the three test suites, and `npm run check` before reporting a phase.
- Stop at the end of each phase and report before going on.
