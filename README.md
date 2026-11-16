# Mongo Studio

A MongoDB client for Orca, built from Orca's own components so it follows every Orca theme. It
has no AI features.

**Status:** Phases 1 (connections and navigation) and 2 (querying and data viewing) are done.
Later phases add the shell, aggregation, admin, data movement and saved tasks.

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

## Develop

```sh
npm install
orca plugin dev load .   # Orca prints the access it needs and an --approve fingerprint
npm run typecheck
npm test                 # unit, protocol and panel tests (no database)
dev/shots.sh             # screenshots of every view, light and dark (Orca's window must be hidden)
npm run check            # orca plugin check + validate
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
- The plugin isn't packaged for installation yet. Installed plugins don't run `npm install`,
  so a release needs a bundled worker plus the Kerberos binary for each platform. Until then,
  load the folder with `orca plugin dev load`.

## License

[MIT](LICENSE)
