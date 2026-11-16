# Mongo Studio

A MongoDB client for Orca, built from Orca's own components so it follows every Orca theme. It
has no AI features.

**Status:** Phases 1 (connections and navigation), 2 (querying and data viewing), 3 (shell and
code), 4 (aggregation and explain) and 5 (administration and schema) are done. Later phases add
data movement and saved tasks.

## What Phase 1 does

- **Connections**
  - Create, edit, clone and delete connections, and put them in groups.
  - Edit a connection as a form or as a connection string; both change the same settings.
  - Types: standalone, replica set, sharded (mongos list) and `mongodb+srv`.
  - Sign-in: SCRAM-SHA-1/256, X.509, LDAP (PLAIN), Kerberos (GSSAPI), AWS IAM (access keys or the
    AWS SDK chain) and OIDC (browser sign-in with PKCE, or Azure/GCP/Kubernetes identity).
  - TLS: CA and client certificate as a file path or pasted PEM, key password, and options to
    allow invalid host names or certificates.
  - SSH tunnel: password, or a private key with passphrase. The host key is pinned on first use
    and a changed key is refused.
  - Read preference, app name, timeouts, default database, and other URI options passed through.
- **Test connection.** Runs DNS, SSH, TCP, TLS, handshake, sign-in and permission checks in turn.
  Each step reports what it found, and a failed step gives a next step to try.
- **Tree.** Connections → databases → collections, views, time-series collections, GridFS buckets,
  indexes, users and custom roles. Nodes show counts and sizes. Selecting a node shows its details
  and definition. The tree has a filter and favourites, and each node can be refreshed.
- **Import and export.**
  - Import connection strings (one per line), Mongo Studio exports or MongoDB Compass exports.
  - Export saves through Orca's save dialog and never includes secrets.
- **Palette commands:** New connection, Import connections, Export connections, Disconnect all.

## What Phase 2 does

- **Collection tabs.** Open a collection, view or time-series collection from the tree (the Open
  button, or Enter). Each opens as its own tab, so several can be open at once. Views are read
  only.
- **Query bar.** Filter, projection, sort, collation, skip and limit, in mongo shell syntax:
  unquoted keys, single quotes, regex literals, comments, trailing commas, and `ObjectId`,
  `ISODate`/`new Date`, `NumberInt`, `NumberLong`, `NumberDecimal`, `UUID`, `BinData`, `Timestamp`,
  `MinKey`/`MaxKey` and `RegExp`. It is parsed, never evaluated, and errors give the line and column.
- **Query Builder.** Field, operator and value rows in nested AND/OR groups. It applies to the
  filter, and loads back from a filter when the filter fits. "Add to query" on a field in the Tree
  view adds a row (in place of drag and drop).
- **Results.**
  - Pages of 20 to 500. The next page reads on from the open cursor. The total is counted
    separately with a time limit, so the first page never waits for it.
  - Table: one column per top-level field, sorting by column, multiple selection, and "Show a
    sub-document as columns".
  - Tree: documents → fields, each with its BSON type.
  - JSON: relaxed or canonical Extended JSON.
- **Editing.**
  - Field editor: an input that fits the field's BSON type, with the type as its own choice. It
    covers ObjectId, Date, Decimal128, Int64, Int32, Double, Binary, UUID, regex, Timestamp,
    MinKey/MaxKey, null, boolean, string, JavaScript, and documents and arrays.
  - Add and remove fields.
  - Document editor: shell syntax or canonical Extended JSON.
  - Insert, clone and delete, including bulk delete of the selected rows. Deleting asks first and
    names the namespace and document count.
- **History and saved queries.** The last 50 queries run on each collection, and named saved
  queries, are kept per connection.

## What Phase 3 does

- **The shell.** A `.mongodb.js` file opens in the Mongo Shell editor. Create one with
  "Mongo Studio: New shell script" in the + menu or the command palette.
  - The first line names the connection and database, so the file opens ready to run:
    `// @mongo-studio connection="Local dev" db="shop"`. The pickers above the editor change it.
  - Ctrl+Enter runs the selection or the statement under the cursor. Ctrl+Shift+Enter runs the
    whole script. Stop ends a running script, even an endless loop.
  - Scripts run like the legacy mongo shell: database calls return their results, so
    `db.orders.findOne().total`, `forEach` and `for … of` over a cursor need no `await` (it still
    works). Variables last between runs until "Clear variables". `use`, `show dbs`,
    `show collections`, `print`, `printjson`, `sleep` and the BSON constructors work.
  - Output appears under the editor, with each statement's value and the line it came from. An
    error stops the script and is underlined at its line.
  - Cursors, arrays of documents and documents open in the panel's **Shell** tab with the same
    Table, Tree and JSON views and paging as a query. A find opens as a query in its collection's
    tab with "Open as query".
  - Autocomplete: collections, fields sampled from the collection, shell methods, and the operators
    that fit where the cursor is (query, update, stage, accumulator, expression or projection).
- **Code generation.** The Code tab under the editor, and a Code section on collection tabs and
  shell results, turn a find or aggregate into code for mongosh, Node.js, Python, Java, C#, PHP or
  Ruby. Every BSON type keeps its type in the generated code.
- **SQL → MQL.** The SQL tab translates a SELECT into a statement you can run or insert into the
  script: WHERE (with IN, BETWEEN, LIKE, IS NULL), GROUP BY with COUNT/SUM/AVG/MIN/MAX and HAVING,
  ORDER BY, LIMIT/OFFSET, DISTINCT, and INNER/LEFT JOIN as `$lookup`. Notes say where MongoDB
  differs from SQL. Anything it can't translate faithfully is refused with the position.

## What Phase 4 does

- **Aggregation editor.** "Aggregate" on a collection, view or time-series collection in the tree
  opens its aggregation tab. A collection tab's layers button opens it with the query bar's
  filter, sort, skip, limit and projection as stages, and a shell aggregate result opens there with
  "Open in the aggregation editor".
  - Stages are listed in a table. Add a stage after the selected one, move it up or down, turn it
    off and on, duplicate it or remove it (Orca has no drag and drop, so these are buttons).
  - The selected stage is edited in shell syntax, starting from a template for its operator. The
    preview shows its **input** (the stages before it) and its **output**, 5 to 100 documents
    each. Ctrl+Enter or "Update preview" reads them again.
  - "Edit as text" shows the whole pipeline as one array; applying it replaces the stages.
  - Run pages the results like a query, with Table, Tree and JSON views and a count. "Allow disk
    use" applies to the preview, the run and explain.
  - A pipeline ending in `$out` or `$merge` asks first and names the collection it writes to. It
    runs once: never in a preview, a count or a page, and explain only plans it.
  - "Create a view" makes a view on the collection from the stages that are on, and offers to
    open it.
  - Saved pipelines keep each stage as typed, off ones included, per collection.
  - The Code section turns the pipeline into mongosh, Node.js, Python, Java, C#, PHP or Ruby.
- **Explain plans** for the query in a collection tab (the gauge button) and for a pipeline:
  - Verbosity: queryPlanner (plan only), executionStats or allPlansExecution.
  - Visual: the plan (indexes or collection scan), documents returned and examined, index keys
    examined, time, rejected plans; warnings for collection scans, in-memory sorts, spills to disk
    and a high examined-to-returned ratio; and the plan as a tree with each stage's own numbers.
    Selecting a stage shows its details (bounds, filter, sort pattern, …).
  - It reads the classic engine, the slot-based engine of MongoDB 7 and 8, pipelines with a
    `$cursor` stage, and sharded plans (one branch per shard).
  - Raw: the server's whole answer as JSON.
- **Shell:** `cursor.explain(verbosity)`, `db.coll.explain(verbosity).find(…)` (with `.finish()`
  to read it in a script), `.aggregate(…)`, `.count(…)` and `.distinct(…)`.

## What Phase 5 does

Each of these is a tab next to the collection tabs, opened from the tree's action bar.

- **Manage a collection** (gear button on a collection or view, or on a collection tab;
  "Manage indexes" on the Indexes node or an index):
  - Overview: documents, sizes, indexes, capped limits, clustering, time-series fields and expiry,
    and the creation options.
  - **Index manager.** Every index with its key, kind, size and use count (`$indexStats`), and
    builds in progress. New index: field rows of ascending, descending, text, 2dsphere, 2d, hashed
    or wildcard (`$**`, on all fields or under one), with unique, sparse, hidden, TTL, partial
    filter, collation, wildcard projection, text weights and languages, and 2d bits/min/max. The
    form checks what the server would refuse and shows the mongosh command. Hide or unhide an
    index, change a TTL, drop an index (after a confirmation).
  - **Validation.** The rules in shell syntax with level and action; "Check documents" counts the
    documents that break them (and names the first); "From the schema" builds rules from a sample.
  - Rename (also to another database, optionally replacing the target), make capped, delete all
    documents, drop. Clearing and dropping ask first, naming the namespace and document count.
- **Database** ("Manage" on a database; the + button on a connection makes a new one):
  statistics and collections; create a collection that is plain, capped (size, most documents),
  time series (time and meta fields, granularity, expiry) or clustered (expiry), with a validator
  and collation, showing the mongosh command; the **profiler** (level, slow threshold, sample rate)
  and its newest entries with filters by operation, duration and collection; drop the database,
  after typing its name. `admin`, `local` and `config` are never dropped.
- **Users and roles** ("Users" on a database, or the Users and Roles nodes): users with their
  roles and sign-in mechanisms, custom roles with their privileges. Create and edit users
  (password, roles from the built-in and custom lists or typed, custom data, SCRAM mechanisms) and
  roles (privileges in shell syntax, inherited roles); drop either after a confirmation. A typed
  password lives only in the open form.
- **Server** (gauge button on a connected connection): serverStatus in sections (server,
  connections, operations, network, memory and WiredTiger cache, replication, asserts), rates per
  second between readings, replica set members with their lag, and a live mode that reads every
  5 s. **Current operations** with filters (namespace, running time, idle connections, the
  server's own work), details, and Stop (killOp) after a confirmation.
- **Schema Explorer** (chart button on a collection or view): samples 100 to 10,000 documents
  (`$sample`, after an optional filter) and shows every field as a tree, arrays' elements included,
  with its types and how often it is there. A field shows its type split, a histogram of numbers or
  dates, its most common strings, lengths and array sizes. The sample's shape exports as a MongoDB
  `$jsonSchema` validator (sent to the Manage tab with "Use as validator") or a JSON Schema
  (draft 2020-12), saved with Save as file.

### Size limits

Orca refuses a panel request or answer past 1 MiB, 10,000 objects or arrays, or 100 levels deep.
In canonical Extended JSON every number is an object, so pages are sized in Orca's own measure
(`src/shared/host-size.ts`).

- A page can stop before the page size. Next page goes on from there.
- Long strings, big arrays and binary data show a preview. Editing always loads the whole document.
- Documents too big for one request are edited in the shell. The editor says why.

## Where things are

| Path | What |
|---|---|
| `src/panel.tsx`, `src/panel/` | The right-sidebar panel: Orca components only |
| `src/worker.ts`, `src/worker/` | The worker: saved connections, secrets, MongoClients, SSH tunnels, diagnostics, tree loading |
| `src/protocol.ts` | The typed panel ↔ worker contract |
| `src/panel/collection-*.tsx`, `results-view.tsx`, `editors-view.tsx` | Collection tabs: query bar, Query Builder, results, editors, history |
| `src/worker/query.ts` | Query cursors and pages, counts, document writes, history and saved queries |
| `src/editor/` | The Mongo Shell custom editor: CodeMirror, output, Code and SQL tabs |
| `src/editor/vendor/` | CodeMirror bundled into one file by `dev/build-codemirror.mjs` |
| `src/worker/shell.ts`, `shell-thread.mjs` | Shell sessions: the script thread and the database calls it makes |
| `src/panel/shell-*.ts(x)` | The panel's Shell tab and the Code section |
| `src/shared/js-scan.ts`, `shell-prepare.ts`, `shell-call.ts`, `shell-vocab.ts` | Statements, autocomplete places, statement → operation, shell vocabulary |
| `src/shared/codegen.ts`, `sql-to-mql.ts` | Code generation and SQL translation |
| `src/panel/aggregate-*.ts(x)`, `src/shared/pipeline.ts` | Aggregation tabs and the stage model |
| `src/panel/explain-*.ts(x)`, `src/shared/explain.ts` | Explain sections and the explain reader |
| `src/worker/aggregate.ts` | Stage previews, explain, views from a pipeline, saved pipelines |
| `src/panel/admin-*.ts(x)` | Administration tabs: shared state, notices, drawing a tab by kind |
| `src/panel/manage-*`, `database-*`, `users-*`, `server-*`, `schema-*` | The Manage, Database, Users and roles, Server and Schema tabs |
| `src/worker/admin.ts`, `users.ts`, `server.ts`, `schema.ts` | Indexes, collections, databases, profiler; users and roles; server status and operations; schema sampling |
| `src/shared/index-spec.ts`, `schema.ts` | The index form, and the schema analysis, histograms and JSON Schema export |
| `src/shared/` | Pure code both sides use: connection model, URI parser/builder, import/export, tree keys, the shell literal parser, Extended JSON views, the Query Builder and field-editor models |
| `test/` | Integration tests against the docker databases |
| `dev/` | Docker databases, seed data and test fixtures |

## Security

- Passwords, keys, pasted certificates and AWS secrets are stored only through `secrets:own`
  (the OS keyring). The worker never sends them back to the panel, which only learns whether
  each secret is saved.
- When Orca reports that it cannot encrypt secrets on a machine, secrets stay in the worker's
  memory and are never written. The panel says so.
- Credentials go to the driver as options, never inside a URI string. Exports never contain
  secrets.

The plugin asks for `storage:own` and `secrets:own` only.

Shell scripts run in a worker thread of the plugin's worker, in a separate JavaScript context
that offers only the shell's API. Like mongosh, that context is not a security boundary: run only
scripts you trust. A script runs only when you press Run.

## Develop

```sh
npm install
orca plugin dev load .   # Orca prints the access it needs and an --approve fingerprint
npm run typecheck
npm test                 # unit, protocol and panel tests (no database)
dev/shots.sh             # screenshots of every view, light and dark (Orca's window must be hidden)
npm run check            # orca plugin check + validate
node dev/build-codemirror.mjs   # after upgrading CodeMirror: rebuilds src/editor/vendor/
```

If the `orca` command fails on this machine, run
`ELECTRON_RUN_AS_NODE=1 node /usr/lib/orca-ide/app.asar.unpacked/out/cli/index.js` instead; the
npm scripts already do.

### Databases

```sh
# Dev replica set with seeded demo data (shop, blog, analytics, types_zoo)
docker compose -f dev/docker-compose.yml up -d --wait
docker compose -f dev/docker-compose.yml exec mongo mongosh --quiet /seed/seed.mongodb.js
# mongodb://localhost:27017/?replicaSet=rs0&directConnection=true

# Integration tests: SCRAM (27019), TLS + X.509 (27018), SSH bastion (2222), plus querying and
# editing on the seeded dev replica set above
dev/test-env/make-certs.sh
docker compose -f dev/docker-compose.yml --profile test up -d --wait --build
dev/test-env/setup.sh
npm run test:it

# Kerberos and LDAP: MongoDB Enterprise (27020), an MIT KDC and OpenLDAP
docker compose -f dev/docker-compose.yml --profile enterprise up -d --wait --build
dev/test-env/setup-enterprise.sh
npm run test:enterprise
```

## Known limits

- Through an SSH tunnel, the plugin connects to the first database host only, since the driver
  can't reach the other replica set members it discovers.
- Kerberos uses the ticket cache on your computer, so run `kinit` first.
- The shell covers the common mongosh API, not all of it: no `rs.*`, `sh.*`, `load()`, `watch`,
  sessions or transactions. `it` is not needed, since results page in the panel. Only the newest
  run's results stay open in the panel.
- A stage preview runs the stages before it on the whole collection, then keeps the first
  documents. A slow `$group` or `$sort` early in a big pipeline makes the preview slow too (it
  stops after 30 s).
- Paging a pipeline's results past the open cursor runs the pipeline again with `$skip`.
- Orca has no chart component, so the Schema Explorer draws distributions as progress bars and
  tables with text bars. Histograms are built from up to 5,000 values per field and scaled.
- Live server status refreshes while the tab stays open; it waits in the worker between readings,
  since a components panel has no timers.
- The plugin isn't packaged for installation yet. Installed plugins don't run `npm install`,
  so a release needs a bundled worker plus the Kerberos binary for each platform. Until then,
  load the folder with `orca plugin dev load`.

## License

[MIT](LICENSE)
