# Mongo Studio

A full MongoDB client inside [Orca](https://orca.dev). Browse your databases, query and edit
documents, build aggregation pipelines stage by stage, run mongo shell scripts and administer
servers, all from Orca's sidebar. It is built from Orca's own components, so it looks at home
in every Orca theme, light or dark.

![Mongo Studio](media/cover.webp)

## At a glance

- **Connect** to standalone servers, replica sets, sharded clusters and Atlas, through TLS or SSH,
  signing in with SCRAM, X.509, LDAP, Kerberos, AWS IAM or OIDC. **Test connection** says which
  step failed and why.
- **Browse** databases and collections in a tree, and open each collection in its own tab.
- **Query** in mongo shell syntax or with the **Query Builder**; see results as a Table, a Tree
  or JSON, and edit documents in place.
- **Aggregate** stage by stage, with a preview of every stage's input and output, and read
  **explain plans**.
- **Script** in the **Mongo Shell** editor, and turn any query into driver code or a `SELECT`
  into MongoDB.
- **Administer** indexes, validation, users and roles, and watch server status.
- **Move data:** import, export, copy between connections, compare and sync, GridFS.

## Install

In Orca, open **Settings → Plugins** and install **Mongo Studio** from the plugin directory. You
can also install it from its repository:

```sh
orca plugin install LeoBessin/orca-mongo-studio
```

Mongo Studio runs its own code in a background worker, so Orca asks you to approve it. It asks
for two permissions:

- `storage:own` keeps your connections, query history, saved pipelines and tasks.
- `secrets:own` keeps passwords and keys in your operating system's keyring.

Open **Mongo Studio** from Orca's right sidebar and add your first connection.

## Features

### Browse and query

- A tree of databases, collections, views, time-series collections, GridFS buckets, indexes,
  users and roles, with counts, sizes and a filter.
- One tab per collection. The query bar takes filter, projection, sort, collation, skip and limit
  in mongo shell syntax. Every tab names, under its title, the connection
  it works on, and for a copy, an import or a comparison, each side it reads and writes
  (`From: Prod › shop.orders · Into: Dev › shop.orders`).
- Tabs, their queries and pipelines, and the tree's open nodes come back when you return to the
  panel from another sidebar tab. Connections Orca closed while the panel was idle reopen by
  themselves, except ones that sign in through the browser.
- A **Query Builder** with nested AND/OR groups.
- Results as a **Table**, a **Tree** with BSON types, or **JSON** (relaxed or canonical Extended
  JSON). Results page through the open cursor, and the total is counted separately so the first
  page never waits for it.
- **Open** a document to see it whole, as a tree, Extended JSON or shell syntax, over the results;
  **Back to results** returns to them as they were. **Open in a tab** keeps it in a tab of its own
  next to its collection.
- Edit fields with inputs that match their BSON type, or edit whole documents. Insert, clone and
  delete documents, one at a time or in bulk.
- Per-collection query history and saved queries.

![The connection tree beside a collection tab with results as a table](media/browse.webp)

![The query bar and the Query Builder](media/query.webp)

![A document open in the Tree view, with BSON types](media/document.webp)

### Aggregation and performance

- A stage-by-stage **aggregation editor**. It previews each stage's input and output, and stages
  can be turned off, reordered or duplicated.
- Edit a pipeline as text, save it, or create a view from it. `$out` and `$merge` ask before they
  write.
- **Explain plans** for queries and pipelines: index use, documents examined against returned,
  in-memory sorts and the plan as a tree. Works with the classic and slot-based engines and with
  sharded clusters.

![The aggregation editor with a stage preview, and the pipeline's results](media/aggregate.webp)

### Connections

- Standalone servers, replica sets, sharded clusters and `mongodb+srv` (Atlas).
- Sign-in methods: SCRAM, X.509, LDAP, Kerberos, AWS IAM and OIDC (browser sign-in, Azure, GCP or
  Kubernetes).
- TLS with certificates from a file or pasted PEM.
- SSH tunnels by password or key. The host key is pinned on first use.
- Edit a connection as a form or as a connection string; both stay in sync.
- **Test connection** checks DNS, SSH, TCP, TLS, the handshake, sign-in and permissions in turn.
  A failed step says what to try next.
- Groups, favourites and read-only connections.
- Import connection strings or MongoDB Compass exports. Exports never contain secrets.

![The connection form, and Test connection results step by step](media/connection.webp)

### Mongo Shell

- `.mongodb.js` files open in a shell editor with syntax highlighting and autocomplete for
  collections, fields, shell methods and operators.
- **Ctrl+Enter** runs the statement under the cursor. **Ctrl+Shift+Enter** runs the whole script.
- Scripts run like the classic mongo shell: `db.orders.findOne().total` and cursor loops need no
  `await`, and variables last between runs.
- Results open in the panel with the same Table, Tree and JSON views as a query.
- **Code** turns any find or aggregation into mongosh, Node.js, Python, Java, C#, PHP or Ruby.
- **SQL** translates a `SELECT` (with `WHERE`, `GROUP BY`, `JOIN`, `ORDER BY` and more) into
  MongoDB queries.

![The Mongo Shell editor beside its results in the panel](media/shell.webp)

### Administration

- **Indexes:** every index with its size and usage. Create any kind of index: compound, text,
  geospatial, hashed, wildcard, TTL, partial, unique or hidden.
- **Validation:** edit the rules, check existing documents against them, or generate rules from a
  sample.
- **Collections and databases:** create plain, capped, time-series and clustered collections, or
  rename, clear and drop them. Includes the database profiler.
- **Users and roles:** create and edit users and custom roles.
- **Server:** live server status, replica set members with their lag, and current operations you
  can stop.
- **Schema Explorer:** samples a collection and shows every field with its types, how often it
  appears, and histograms of its values. It can export the result as a `$jsonSchema` validator or
  a JSON Schema.

### Data movement

- **Import** JSON, CSV/TSV (with type inference per column) and mongodump BSON, including whole
  dump folders.
- **Export** to JSON, CSV or BSON, from a collection, a query, a pipeline or a whole database.
- **Copy** collections or databases between connections, with their indexes and options.
- **Compare and sync** two collections, with a field-by-field view of each difference.
- **GridFS:** browse, preview, upload, download, rename and delete files.
- Long operations run in the background with progress, cancel and an error report.

### Workflow

- **Saved tasks:** save any import, export, copy, compare or sync and run it again in one click.
  Its last result is kept with it.
- **Read-only connections:** Mongo Studio refuses every write through them, in tabs and in the
  shell.
- **Confirmations** before anything is dropped, cleared or replaced. Each one names the namespace
  and its document count.
- Command palette entries and shortcuts that never clash with Orca's own:
  **Mod+Alt+Shift+T** shows saved tasks and **Mod+Alt+Shift+R** shows shell results.

## Security

- Passwords, keys, certificates and AWS secrets are stored only in the OS keyring, through Orca.
  The panel never receives them back; it only learns whether each one is saved.
- If Orca can't encrypt secrets on a machine, they stay in memory and are never written to disk.
  The panel says so.
- Credentials go to the driver as options, never inside a connection string.
- Shell scripts run in a separate context in the worker. Like mongosh, that context is not a
  security boundary, so run only scripts you trust.
- Mongo Studio collects no data and has no telemetry.

## Limitations

- **Kerberos** needs the native `kerberos` module, which installed plugins can't include. To use
  Kerberos, run Mongo Studio from a clone of this repository (see [CONTRIBUTING.md](CONTRIBUTING.md)) after `kinit`.
- Through an **SSH tunnel**, Mongo Studio connects to the first host of a replica set only.
- The shell covers the common mongosh API. It doesn't include `rs.*`, `sh.*`, `load()`, change
  streams, sessions or transactions.
- **Read-only** mode is enforced by Mongo Studio, not by the server. For a hard guarantee, connect
  with a read-only database user.
- Imports and exports read and write paths on the computer running Orca. Downloads through the
  save dialog are limited to 64 MiB; larger files go to a path.
- Saved tasks run when you start them. Nothing runs on a schedule.

## Contributing

Building, testing and releasing Mongo Studio are covered in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

Mongo Studio is an independent project. It is not affiliated with or endorsed by MongoDB, Inc.
MongoDB is a trademark of MongoDB, Inc.
