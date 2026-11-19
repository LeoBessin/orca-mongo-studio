// Mongo Studio's worker: owns saved connections, secrets, open MongoClients and SSH tunnels, and
// answers the panel through the typed protocol in src/protocol.ts. Orca transpiles it on load.
import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import type { CollectionKind, ConnectionsState, ImportReport, SaveResult } from './protocol'
import { cloneDef, connectionSubtitle, emptyConnection, validateConnection, type ConnectionDef } from './shared/model'
import { canonicalGroup, existingGroups, normalizeGroup } from './shared/groups'
import { exportableTasks, exportConnections, importConnections, resolveTasks } from './shared/transfer'
import {
  checkValidation,
  clearCollection,
  collectionInfo,
  convertToCapped,
  createCollection,
  createIndex,
  databaseInfo,
  dropCollection,
  dropDatabase,
  dropIndex,
  listIndexes,
  modifyIndex,
  profileEntries,
  profilerStatus,
  renameCollection,
  setProfiler,
  setValidation
} from './worker/admin'
import { createView, explainAggregate, explainFind, PipelineLibraryStore, previewStage } from './worker/aggregate'
import { ClientPool } from './worker/client'
import { testConnection } from './worker/diagnose'
import { deleteDocuments, getDocument, insertDocuments, QueryLibraryStore, QuerySessions, replaceDocument, updateField } from './worker/query'
import { analyzeSchema } from './worker/schema'
import { previewUpdate, updateMany } from './worker/update'
import { currentOps, killOp, serverStatus, sleep } from './worker/server'
import { ShellService } from './worker/shell'
import { ConnectionStore } from './worker/store'
import { treeChildren, treeDetails, type TreeContext } from './worker/tree'
import { dropRole, dropUser, listUsers, saveRole, saveUser } from './worker/users'
import { diffPair, runCompare, runSync } from './worker/compare'
import { runExport, sampleFields } from './worker/export'
import { deleteFile, downloadFile, listFiles, previewFile, renameFile, uploadFile } from './worker/gridfs'
import { previewImport, runImport } from './worker/import'
import { Jobs, Uploads } from './worker/jobs'
import { TaskStore } from './worker/tasks'
import { readOnlyMessage, writeStageOf } from './shared/read-only'
import { resultSummary, type TaskRequest } from './shared/tasks'
import type { ExportDestination, ExportOptions, ExportSource, ImportOptions, JobState, NavigateView, Namespace, DataSource } from './protocol'
import type { CompareRules } from './shared/compare'
import type { JsonObject } from './shared/ejson-view'

let pool: ClientPool | undefined
let queries: QuerySessions | undefined
let shell: ShellService | undefined
let jobs: Jobs | undefined

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

export default function activate(orca: OrcaWorkerApi): void {
  const store = new ConnectionStore(orca)
  const tasks = new TaskStore(orca)
  const broadcastTasks = async (): Promise<void> => {
    orca.panels.post('tasks.changed', { tasks: await tasks.list() })
  }

  const state = async (): Promise<ConnectionsState> => {
    const [defs, favourites, secretsProtection] = await Promise.all([store.list(), store.favourites(), store.secretsProtection()])
    return {
      connections: defs.map((d) => ({
        id: d.id,
        name: d.name,
        group: d.group,
        subtitle: connectionSubtitle(d),
        topology: d.topology,
        connected: pool?.isOpen(d.id) ?? false,
        readOnly: d.readOnly,
        resumable: secretsProtection === 'os-keyring' && !(d.auth.mechanism === 'MONGODB-OIDC' && d.auth.oidcFlow === 'browser')
      })),
      favourites,
      secretsProtection
    }
  }
  const broadcast = async (): Promise<void> => {
    orca.panels.post('connections.changed', await state())
  }

  const clients = new ClientPool(
    async (id) => {
      const def = await store.get(id)
      return def ? { def, secrets: await store.resolveSecrets(id, {}) } : undefined
    },
    {
      onChange: () => void broadcast(),
      onOidcSignIn: (id, name, url) => {
        orca.panels.post('oidc.signIn', { connectionId: id, name, url })
      },
      onFirstHostKey: async (id, hostKey) => {
        const def = await store.get(id)
        if (!def || def.ssh.knownHostKey) return
        def.ssh.knownHostKey = hostKey
        await store.put(def)
        orca.log(`Pinned the SSH host key for "${def.name}".`)
      }
    }
  )
  pool = clients
  const sessions = new QuerySessions((id) => clients.get(id))
  queries = sessions
  const library = new QueryLibraryStore(orca)
  const pipelines = new PipelineLibraryStore(orca)
  const shells = new ShellService({
    client: (id) => clients.get(id),
    connectionName: async (id) => (await requireDef(id)).name,
    checkWrite: (id, action) => writable(id, action),
    announce: (summary) => orca.panels.post('shell.results', summary),
    log: (message) => orca.log(message)
  })
  shell = shells

  const requireDef = async (id: string): Promise<ConnectionDef> => {
    const def = await store.get(id)
    if (!def) throw invalid('This connection no longer exists.')
    return def
  }

  /** Refuses a change through a read-only connection, before connecting. Every request that
   *  writes to a database calls it, and so does the shell for each call that writes. */
  const writable = async (connectionId: string, action: string): Promise<void> => {
    const def = await requireDef(connectionId)
    if (def.readOnly) throw Object.assign(new Error(readOnlyMessage(def.name, action)), { code: 'not_permitted' })
  }

  const tree: TreeContext = {
    client: (id) => clients.get(id),
    def: (id) => store.get(id),
    isOpen: (id) => clients.isOpen(id)
  }

  orca.panels.handle('connections.state', state)

  orca.panels.handle('connections.get', async ({ id }) => {
    const def = await requireDef(id)
    return { def, secrets: await store.secretFlags(id) }
  })

  orca.panels.handle('connections.save', async ({ def, secrets }): Promise<SaveResult> => {
    const existing = def.id ? await store.get(def.id) : undefined
    const next = cloneDef(def)
    const now = Date.now()
    if (!existing) {
      next.id = def.id || randomUUID()
      next.createdAt = now
    }
    next.updatedAt = now
    next.name = next.name.trim()
    const others = (await store.list()).filter((d) => d.id !== next.id)
    next.group = canonicalGroup(normalizeGroup(next.group), existingGroups(others))
    const errors = validateConnection(next, await store.secretFlags(existing ? next.id : undefined, secrets))
    if (errors.length) return { ok: false, errors }
    await store.applySecrets(next.id, secrets)
    await store.put(next)
    // New settings apply on the next connect.
    await clients.disconnect(next.id)
    await broadcast()
    return { ok: true, id: next.id }
  })

  orca.panels.handle('connections.clone', async ({ id }) => {
    const source = await requireDef(id)
    const copy = cloneDef(source)
    copy.id = randomUUID()
    copy.name = `${source.name} (copy)`
    copy.createdAt = copy.updatedAt = Date.now()
    await store.put(copy)
    await store.copySecrets(id, copy.id)
    await broadcast()
    return { id: copy.id }
  })

  orca.panels.handle('connections.delete', async ({ id }) => {
    await shells.closeFor(id)
    await sessions.closeFor(id)
    await clients.disconnect(id)
    await store.remove(id)
    await library.forget(id)
    await pipelines.forget(id)
    if (await tasks.forgetConnection(id)) await broadcastTasks()
    await broadcast()
    return null
  })

  orca.panels.handle('connections.renameGroup', async ({ from, to }) => {
    const defs = (await store.list()).filter((d) => d.group === from)
    for (const d of defs) d.group = normalizeGroup(to)
    await store.putMany(defs)
    await broadcast()
    return null
  })

  orca.panels.handle('connections.import', async ({ text }) => {
    const now = Date.now()
    const result = importConnections(text, () => randomUUID(), now, (id) => emptyConnection(id, now))
    const report: ImportReport = { imported: [], errors: result.errors }
    const saved = await store.list()
    const groups = existingGroups(saved)
    for (const item of result.items) {
      item.def.group = canonicalGroup(item.def.group, groups)
      await store.applySecrets(item.def.id, item.secrets)
      report.imported.push({ id: item.def.id, name: item.def.name, warnings: item.warnings })
    }
    await store.putMany(result.items.map((i) => i.def))
    await broadcast()
    if (result.tasks.length) {
      const resolved = resolveTasks(result.tasks, result.items.map((i) => i.def), saved)
      const out = resolved.tasks.length ? await tasks.addMany(resolved.tasks).catch((error: unknown) => ({ added: [], errors: [error instanceof Error ? error.message : String(error)] })) : { added: [], errors: [] }
      report.errors.push(...resolved.errors, ...out.errors)
      report.tasks = out.added
      if (out.added.length) await broadcastTasks()
    }
    return report
  })

  orca.panels.handle('connections.export', async ({ ids, tasks: withTasks }) => {
    const all = await store.list()
    const chosen = ids ? all.filter((d) => ids.includes(d.id)) : all
    const travel = withTasks === false ? [] : exportableTasks(chosen, await tasks.list())
    return { json: exportConnections(chosen, Date.now(), travel), count: chosen.length, tasks: travel.length }
  })

  orca.panels.handle('connections.test', async ({ def, secrets, id }, { panel }) => {
    const resolved = await store.resolveSecrets(id && (await store.get(id)) ? id : undefined, secrets)
    return testConnection(def, resolved, (url) => {
      orca.panels.post('oidc.signIn', { connectionId: def.id, name: def.name, url }, { panel: panel.id })
    })
  })

  orca.panels.handle('connections.connect', async ({ id }) => {
    await requireDef(id)
    await clients.get(id)
    return null
  })

  orca.panels.handle('connections.disconnect', async ({ id }) => {
    await shells.closeFor(id)
    await sessions.closeFor(id)
    await clients.disconnect(id)
    return null
  })

  orca.panels.handle('connections.forgetHostKey', async ({ id }) => {
    const def = await requireDef(id)
    def.ssh.knownHostKey = ''
    await store.put(def)
    await clients.disconnect(id)
    await broadcast()
    return null
  })

  orca.panels.handle('tree.children', async ({ key }) => ({ nodes: await treeChildren(tree, key) }))
  orca.panels.handle('tree.details', ({ key }) => treeDetails(tree, key))

  // ---- Queries and documents ----

  const clientFor = async (connectionId: string) => {
    await requireDef(connectionId)
    return clients.get(connectionId)
  }

  orca.panels.handle('query.run', async ({ ns, spec, pageSize, text }) => {
    await requireDef(ns.connectionId)
    const page = await sessions.page(randomUUID(), ns, spec, 0, pageSize)
    // History is a convenience: a storage failure must not lose the results.
    if (text) await library.record(ns, text, Date.now()).catch((error: unknown) => orca.log(`Could not record query history: ${String(error)}`))
    return page
  })
  orca.panels.handle('query.page', async ({ queryId, ns, spec, offset, pageSize }) => {
    await requireDef(ns.connectionId)
    return sessions.page(queryId, ns, spec, offset, pageSize)
  })
  orca.panels.handle('query.count', ({ ns, spec }) => sessions.count(ns, spec))
  orca.panels.handle('query.close', async ({ queryId }) => {
    await sessions.close(queryId)
    return null
  })

  orca.panels.handle('doc.get', async ({ ns, id }) => ({ doc: await getDocument(await clientFor(ns.connectionId), ns, id) }))
  orca.panels.handle('doc.updateField', async ({ ns, id, path, value, remove }) => {
    await writable(ns.connectionId, 'changing a document')
    return updateField(await clientFor(ns.connectionId), ns, id, path, value, remove === true)
  })
  orca.panels.handle('doc.replace', async ({ ns, id, doc }) => {
    await writable(ns.connectionId, 'replacing a document')
    return replaceDocument(await clientFor(ns.connectionId), ns, id, doc)
  })
  orca.panels.handle('doc.insert', async ({ ns, docs }) => {
    await writable(ns.connectionId, 'inserting documents')
    return insertDocuments(await clientFor(ns.connectionId), ns, docs)
  })
  orca.panels.handle('doc.deleteMany', async ({ ns, ids }) => {
    await writable(ns.connectionId, 'deleting documents')
    return deleteDocuments(await clientFor(ns.connectionId), ns, ids)
  })
  // The preview tries the change on one document in a transaction it aborts: still a write.
  orca.panels.handle('doc.updatePreview', async ({ ns, scope, update }) => {
    await writable(ns.connectionId, 'updating documents')
    return previewUpdate(await clientFor(ns.connectionId), ns, scope, update)
  })
  orca.panels.handle('doc.updateMany', async ({ ns, scope, update }) => {
    await writable(ns.connectionId, 'updating documents')
    return updateMany(await clientFor(ns.connectionId), ns, scope, update)
  })

  orca.panels.handle('query.explain', async ({ ns, spec, verbosity }) => explainFind(await clientFor(ns.connectionId), ns, spec, verbosity))

  // ---- Aggregation ----

  const pipelineWritable = async (ns: Namespace, pipeline: unknown): Promise<void> => {
    const stage = writeStageOf(pipeline)
    if (stage) await writable(ns.connectionId, `running a pipeline that writes with ${stage}`)
  }
  orca.panels.handle('agg.run', async ({ ns, pipeline, options, pageSize }) => {
    await requireDef(ns.connectionId)
    await pipelineWritable(ns, pipeline)
    return sessions.pageAggregate(randomUUID(), ns, pipeline, options ?? {}, 0, pageSize, true)
  })
  orca.panels.handle('agg.page', async ({ queryId, ns, pipeline, options, offset, pageSize }) => {
    await requireDef(ns.connectionId)
    await pipelineWritable(ns, pipeline)
    return sessions.pageAggregate(queryId, ns, pipeline, options ?? {}, offset, pageSize, false)
  })
  orca.panels.handle('agg.count', async ({ ns, pipeline, options }) => {
    await requireDef(ns.connectionId)
    return sessions.countAggregate(ns, pipeline, options ?? {})
  })
  orca.panels.handle('agg.preview', async ({ ns, before, stage, size, options }) => previewStage(await clientFor(ns.connectionId), ns, before, stage, size, options ?? {}))
  orca.panels.handle('agg.explain', async ({ ns, pipeline, options, verbosity }) => explainAggregate(await clientFor(ns.connectionId), ns, pipeline, options ?? {}, verbosity))
  orca.panels.handle('view.create', async ({ ns, name, pipeline }) => {
    await writable(ns.connectionId, 'creating a view')
    return createView(await clientFor(ns.connectionId), ns, name, pipeline)
  })
  orca.panels.handle('pipelines.list', ({ ns }) => pipelines.read(ns))
  orca.panels.handle('pipelines.save', ({ ns, name, stages }) => pipelines.save(ns, name, stages, Date.now()))
  orca.panels.handle('pipelines.delete', ({ ns, name }) => pipelines.remove(ns, name))

  // ---- Administration ----

  orca.panels.handle('admin.indexes', async ({ ns }) => listIndexes(await clientFor(ns.connectionId), ns))
  orca.panels.handle('admin.createIndex', async ({ ns, key, options }) => {
    await writable(ns.connectionId, 'creating an index')
    return createIndex(await clientFor(ns.connectionId), ns, key, options)
  })
  orca.panels.handle('admin.dropIndex', async ({ ns, name }) => {
    await writable(ns.connectionId, 'dropping an index')
    await dropIndex(await clientFor(ns.connectionId), ns, name)
    return null
  })
  orca.panels.handle('admin.modifyIndex', async ({ ns, name, hidden, expireAfterSeconds }) => {
    await writable(ns.connectionId, 'changing an index')
    await modifyIndex(await clientFor(ns.connectionId), ns, name, { ...(hidden !== undefined ? { hidden } : {}), ...(expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}) })
    return null
  })
  orca.panels.handle('admin.collection', async ({ ns }) => collectionInfo(await clientFor(ns.connectionId), ns))
  orca.panels.handle('admin.setValidation', async ({ ns, validator, level, action }) => {
    await writable(ns.connectionId, 'changing validation rules')
    await setValidation(await clientFor(ns.connectionId), ns, validator, level, action)
    return null
  })
  orca.panels.handle('admin.checkValidation', async ({ ns, validator }) => checkValidation(await clientFor(ns.connectionId), ns, validator))
  orca.panels.handle('admin.renameCollection', async ({ ns, to, toDb, dropTarget }) => {
    await writable(ns.connectionId, 'renaming a collection')
    await renameCollection(await clientFor(ns.connectionId), ns, to, toDb, dropTarget)
    return null
  })
  orca.panels.handle('admin.dropCollection', async ({ ns }) => {
    await writable(ns.connectionId, 'dropping a collection')
    await dropCollection(await clientFor(ns.connectionId), ns)
    return null
  })
  orca.panels.handle('admin.clearCollection', async ({ ns }) => {
    await writable(ns.connectionId, 'deleting every document of a collection')
    return clearCollection(await clientFor(ns.connectionId), ns)
  })
  orca.panels.handle('admin.convertToCapped', async ({ ns, size }) => {
    await writable(ns.connectionId, 'making a collection capped')
    await convertToCapped(await clientFor(ns.connectionId), ns, size)
    return null
  })
  orca.panels.handle('admin.database', async (ref) => databaseInfo(await clientFor(ref.connectionId), ref))
  orca.panels.handle('admin.createCollection', async ({ connectionId, db, spec }) => {
    await writable(connectionId, 'creating a collection')
    await createCollection(await clientFor(connectionId), { connectionId, db }, spec)
    return null
  })
  orca.panels.handle('admin.dropDatabase', async (ref) => {
    await writable(ref.connectionId, 'dropping a database')
    await dropDatabase(await clientFor(ref.connectionId), ref)
    return null
  })
  orca.panels.handle('profiler.status', async (ref) => profilerStatus(await clientFor(ref.connectionId), ref))
  orca.panels.handle('profiler.set', async ({ connectionId, db, level, slowms, sampleRate }) => {
    await writable(connectionId, 'changing the profiler')
    return setProfiler(await clientFor(connectionId), { connectionId, db }, level, slowms, sampleRate)
  })
  orca.panels.handle('profiler.entries', async ({ connectionId, db, filter, limit }) => profileEntries(await clientFor(connectionId), { connectionId, db }, filter ?? {}, limit))
  orca.panels.handle('users.list', async (ref) => listUsers(await clientFor(ref.connectionId), ref))
  orca.panels.handle('users.save', async ({ connectionId, db, draft, isNew }) => {
    await writable(connectionId, isNew ? 'creating a user' : 'changing a user')
    await saveUser(await clientFor(connectionId), { connectionId, db }, draft, isNew)
    return null
  })
  orca.panels.handle('users.drop', async ({ connectionId, db, user }) => {
    await writable(connectionId, 'dropping a user')
    await dropUser(await clientFor(connectionId), { connectionId, db }, user)
    return null
  })
  orca.panels.handle('roles.save', async ({ connectionId, db, draft, isNew }) => {
    await writable(connectionId, isNew ? 'creating a role' : 'changing a role')
    await saveRole(await clientFor(connectionId), { connectionId, db }, draft, isNew)
    return null
  })
  orca.panels.handle('roles.drop', async ({ connectionId, db, role }) => {
    await writable(connectionId, 'dropping a role')
    await dropRole(await clientFor(connectionId), { connectionId, db }, role)
    return null
  })
  orca.panels.handle('server.status', async ({ connectionId, waitMs }, { signal }) => {
    const client = await clientFor(connectionId)
    if (waitMs !== undefined) {
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw invalid('Wait 0 to 60,000 ms.')
      await sleep(waitMs, signal)
    }
    return serverStatus(client)
  })
  orca.panels.handle('server.ops', async ({ connectionId, filter }) => currentOps(await clientFor(connectionId), filter ?? { idle: false, system: false }))
  orca.panels.handle('server.killOp', async ({ connectionId, opid }) => {
    await writable(connectionId, 'stopping an operation')
    await killOp(await clientFor(connectionId), opid)
    return null
  })
  orca.panels.handle('schema.analyze', async ({ ns, size, filter }) => analyzeSchema(await clientFor(ns.connectionId), ns, size, filter))

  // ---- Data movement ----

  const running = new Jobs((message) => orca.log(message))
  jobs = running
  const uploads = new Uploads()
  const nsOf = (ns: { connectionId: string; db: string; collection: string }) => clientFor(ns.connectionId)

  orca.panels.handle('import.upload', ({ uploadId, chunk }) => uploads.append(uploadId, chunk))
  orca.panels.handle('import.preview', ({ source, options, size }) => previewImport(source, options, size, uploads))
  // Each job's start, shared by its request and by saved tasks; `onEnd` hears how it ended.
  type OnEnd = ((state: JobState) => void) | undefined
  const startImport = async (source: DataSource, options: ImportOptions, ns: Namespace, onEnd?: OnEnd): Promise<string> => {
    await writable(ns.connectionId, 'importing')
    const client = await nsOf(ns)
    return running.start('import', 'bytes', (job) => runImport(client, source, options, ns, uploads, job), onEnd)
  }
  const startExport = async (source: ExportSource, options: ExportOptions, destination: ExportDestination, onEnd?: OnEnd): Promise<string> => {
    if (options.format === 'collection' && options.collection) await writable(options.collection.connectionId, 'copying into a collection')
    const client = await clientFor(source.kind === 'database' ? source.connectionId : source.ns.connectionId)
    const kind = options.format === 'collection' ? 'copy' : 'export'
    return running.start(kind, 'documents', (job) => runExport(client, (id) => clientFor(id), source, options, destination, job), onEnd)
  }
  const startCompare = async (a: Namespace, b: Namespace, filter: JsonObject | undefined, rules: CompareRules, onEnd?: OnEnd): Promise<string> => {
    const [ca, cb] = await Promise.all([nsOf(a), nsOf(b)])
    return running.start('compare', 'documents', (job) => runCompare(ca, cb, a, b, filter, rules, job), onEnd)
  }
  const startSync = async (r: { from: Namespace; to: Namespace; filter?: JsonObject; rules: CompareRules; insert: boolean; replace: boolean; remove: boolean }, onEnd?: OnEnd): Promise<string> => {
    await writable(r.to.connectionId, 'syncing into a collection')
    const [cf, ct] = await Promise.all([nsOf(r.from), nsOf(r.to)])
    return running.start('sync', 'documents', (job) => runSync(cf, ct, r.from, r.to, r.filter, r.rules, { insert: r.insert, replace: r.replace, remove: r.remove }, job), onEnd)
  }

  orca.panels.handle('import.start', async ({ source, options, ns }) => ({ jobId: await startImport(source, options, ns) }))
  orca.panels.handle('export.start', async ({ source, options, destination }) => ({ jobId: await startExport(source, options, destination) }))
  orca.panels.handle('export.fields', async ({ ns, filter }) => ({ fields: await sampleFields(await nsOf(ns), ns, filter) }))
  orca.panels.handle('data.count', async ({ ns }) => {
    const client = await nsOf(ns)
    const db = client.db(ns.db)
    const info = (await db.listCollections({ name: ns.collection }, { authorizedCollections: true }).toArray())[0] as { type?: string } | undefined
    if (!info) return { exists: false, count: null }
    const kind: CollectionKind = info.type === 'view' ? 'view' : info.type === 'timeseries' ? 'timeseries' : 'collection'
    const count = kind === 'view' ? null : await db.collection(ns.collection).estimatedDocumentCount({ maxTimeMS: 10_000 }).catch(() => null)
    return { exists: true, count, kind }
  })
  orca.panels.handle('data.collections', async ({ connectionId, db }) => {
    const client = await clientFor(connectionId)
    const names = (await client.db(db).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'))
    return { names: names.sort((a, b) => a.localeCompare(b)) }
  })
  orca.panels.handle('job.poll', ({ jobId, version, waitMs }, { signal }) => running.poll(jobId, version, waitMs, signal))
  orca.panels.handle('job.cancel', ({ jobId }) => {
    running.cancel(jobId)
    return null
  })
  orca.panels.handle('job.read', ({ jobId, offset, size }) => running.read(jobId, offset, size))
  orca.panels.handle('job.close', ({ jobId }) => {
    running.close(jobId)
    return null
  })
  orca.panels.handle('compare.start', async ({ a, b, filter, rules }) => ({ jobId: await startCompare(a, b, filter, rules) }))
  orca.panels.handle('compare.diff', async ({ a, b, id, rules }) => diffPair(await nsOf(a), await nsOf(b), a, b, id, rules))
  orca.panels.handle('compare.sync', async ({ from, to, filter, rules, insert, replace, remove }) => ({ jobId: await startSync({ from, to, ...(filter ? { filter } : {}), rules, insert, replace, remove }) }))
  orca.panels.handle('gridfs.list', async ({ connectionId, db, bucket, filename, skip, limit }) => listFiles(await clientFor(connectionId), { connectionId, db, bucket }, filename, skip, limit))
  orca.panels.handle('gridfs.preview', async ({ connectionId, db, bucket, id }) => previewFile(await clientFor(connectionId), { connectionId, db, bucket }, id))
  orca.panels.handle('gridfs.download', async ({ connectionId, db, bucket, id, destination }) => {
    const client = await clientFor(connectionId)
    return { jobId: running.start('gridfs-download', 'bytes', (job) => downloadFile(client, { connectionId, db, bucket }, id, destination, job)) }
  })
  orca.panels.handle('gridfs.upload', async ({ connectionId, db, bucket, source, filename, contentType, metadata }) => {
    await writable(connectionId, 'uploading a file')
    const client = await clientFor(connectionId)
    return { jobId: running.start('gridfs-upload', 'bytes', (job) => uploadFile(client, { connectionId, db, bucket }, source, filename, contentType, metadata, uploads, job)) }
  })
  orca.panels.handle('gridfs.rename', async ({ connectionId, db, bucket, id, filename }) => {
    await writable(connectionId, 'renaming a file')
    await renameFile(await clientFor(connectionId), { connectionId, db, bucket }, id, filename)
    return null
  })
  orca.panels.handle('gridfs.delete', async ({ connectionId, db, bucket, id }) => {
    await writable(connectionId, 'deleting a file')
    await deleteFile(await clientFor(connectionId), { connectionId, db, bucket }, id)
    return null
  })

  // ---- Saved tasks ----

  orca.panels.handle('tasks.list', async () => ({ tasks: await tasks.list() }))
  orca.panels.handle('tasks.save', async ({ id, name, request }) => {
    const out = await tasks.save(id, name, request)
    orca.panels.post('tasks.changed', { tasks: out.tasks })
    return out
  })
  orca.panels.handle('tasks.rename', async ({ id, name }) => {
    const list = await tasks.rename(id, name)
    orca.panels.post('tasks.changed', { tasks: list })
    return { tasks: list }
  })
  orca.panels.handle('tasks.duplicate', async ({ id }) => {
    const out = await tasks.duplicate(id)
    orca.panels.post('tasks.changed', { tasks: out.tasks })
    return out
  })
  orca.panels.handle('tasks.delete', async ({ id }) => {
    const list = await tasks.remove(id)
    orca.panels.post('tasks.changed', { tasks: list })
    return { tasks: list }
  })
  orca.panels.handle('tasks.run', async ({ id }) => {
    const task = await tasks.get(id)
    const at = Date.now()
    const onEnd = (s: JobState): void => {
      const summary = s.status === 'done' && s.result ? resultSummary(s.result) : s.status === 'cancelled' ? 'Cancelled.' : s.message ?? 'Failed.'
      void tasks
        .recordRun(id, { at, status: s.status, ms: s.ms, summary, errorCount: s.errorCount })
        .then((list) => orca.panels.post('tasks.changed', { tasks: list }))
        .catch((error: unknown) => orca.log(`Could not record the run of task "${task.name}": ${String(error)}`))
    }
    return { jobId: await startTask(task.request, onEnd) }
  })
  const startTask = (r: TaskRequest, onEnd: OnEnd): Promise<string> => {
    switch (r.kind) {
      case 'import':
        return startImport(r.source, r.options, r.ns, onEnd)
      case 'export':
        return startExport(r.source, r.options, r.destination, onEnd)
      case 'compare':
        return startCompare(r.a, r.b, r.filter, r.rules, onEnd)
      case 'sync':
        return startSync(r, onEnd)
    }
  }

  orca.panels.handle('history.list', ({ ns }) => library.read(ns))
  orca.panels.handle('history.clear', ({ ns }) => library.clearHistory(ns))
  orca.panels.handle('saved.save', ({ ns, name, query }) => library.save(ns, name, query, Date.now()))
  orca.panels.handle('saved.delete', ({ ns, name }) => library.remove(ns, name))

  orca.panels.handle('favourites.toggle', async (node) => {
    const favourites = await store.toggleFavourite(node)
    await broadcast()
    return { favourites }
  })

  // ---- Shell ----

  orca.panels.handle('shell.run', async (input, { panel }) => {
    await requireDef(input.connectionId)
    return shells.run(panel.id, input)
  })
  orca.panels.handle('shell.poll', ({ runId, after }, { signal }) => shells.poll(runId, after, signal))
  orca.panels.handle('shell.cancel', ({ runId }) => {
    shells.cancel(runId)
    return null
  })
  orca.panels.handle('shell.reset', (_input, { panel }) => {
    shells.reset(panel.id)
    return null
  })
  orca.panels.handle('shell.latest', () => ({ run: shells.latestSummary() }))
  orca.panels.handle('shell.page', ({ runId, index, offset, pageSize }) => shells.page(runId, index, offset, pageSize))
  orca.panels.handle('shell.databases', async ({ connectionId }) => {
    await requireDef(connectionId)
    return { names: await shells.databases(connectionId) }
  })
  orca.panels.handle('shell.complete', async ({ connectionId, db, collection }) => {
    await requireDef(connectionId)
    return shells.complete(connectionId, db, collection)
  })

  const navigate = (view: NavigateView): string => {
    orca.panels.post('ui.navigate', { view })
    return 'Shown in the Mongo Studio panel. If you do not see it, open Mongo Studio from the right sidebar.'
  }
  orca.commands.register('mongoStudio.newConnection', () => navigate('new'))
  orca.commands.register('mongoStudio.importConnections', () => navigate('import'))
  orca.commands.register('mongoStudio.exportConnections', () => navigate('export'))
  orca.commands.register('mongoStudio.showShellResults', () => navigate('shell'))
  orca.commands.register('mongoStudio.showTasks', () => navigate('tasks'))
  orca.commands.register('mongoStudio.disconnectAll', async () => {
    await shells.closeAll()
    await sessions.closeAll()
    await clients.disconnectAll()
    await broadcast()
    return 'Disconnected every Mongo Studio connection.'
  })
}

export async function deactivate(): Promise<void> {
  jobs?.closeAll()
  await shell?.closeAll()
  await queries?.closeAll()
  await pool?.disconnectAll()
}
