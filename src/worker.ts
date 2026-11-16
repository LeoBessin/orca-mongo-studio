// Mongo Studio's worker: owns saved connections, secrets, open MongoClients and SSH tunnels, and
// answers the panel through the typed protocol in src/protocol.ts. Orca transpiles it on load.
import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import type { ConnectionsState, ImportReport, SaveResult } from './protocol'
import { cloneDef, connectionSubtitle, emptyConnection, validateConnection, type ConnectionDef } from './shared/model'
import { exportConnections, importConnections } from './shared/transfer'
import { createView, explainAggregate, explainFind, PipelineLibraryStore, previewStage } from './worker/aggregate'
import { ClientPool } from './worker/client'
import { testConnection } from './worker/diagnose'
import { deleteDocuments, getDocument, insertDocuments, QueryLibraryStore, QuerySessions, replaceDocument, updateField } from './worker/query'
import { ShellService } from './worker/shell'
import { ConnectionStore } from './worker/store'
import { treeChildren, treeDetails, type TreeContext } from './worker/tree'

let pool: ClientPool | undefined
let queries: QuerySessions | undefined
let shell: ShellService | undefined

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

export default function activate(orca: OrcaWorkerApi): void {
  const store = new ConnectionStore(orca)

  const state = async (): Promise<ConnectionsState> => {
    const [defs, favourites, secretsProtection] = await Promise.all([store.list(), store.favourites(), store.secretsProtection()])
    return {
      connections: defs.map((d) => ({
        id: d.id,
        name: d.name,
        group: d.group,
        subtitle: connectionSubtitle(d),
        topology: d.topology,
        connected: pool?.isOpen(d.id) ?? false
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
    announce: (summary) => orca.panels.post('shell.results', summary),
    log: (message) => orca.log(message)
  })
  shell = shells

  const requireDef = async (id: string): Promise<ConnectionDef> => {
    const def = await store.get(id)
    if (!def) throw invalid('This connection no longer exists.')
    return def
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
    next.group = next.group.trim()
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
    await broadcast()
    return null
  })

  orca.panels.handle('connections.renameGroup', async ({ from, to }) => {
    const defs = (await store.list()).filter((d) => d.group === from)
    for (const d of defs) d.group = to.trim()
    await store.putMany(defs)
    await broadcast()
    return null
  })

  orca.panels.handle('connections.import', async ({ text }) => {
    const now = Date.now()
    const result = importConnections(text, () => randomUUID(), now, (id) => emptyConnection(id, now))
    const report: ImportReport = { imported: [], errors: result.errors }
    for (const item of result.items) {
      await store.applySecrets(item.def.id, item.secrets)
      report.imported.push({ id: item.def.id, name: item.def.name, warnings: item.warnings })
    }
    await store.putMany(result.items.map((i) => i.def))
    await broadcast()
    return report
  })

  orca.panels.handle('connections.export', async ({ ids }) => {
    const all = await store.list()
    const chosen = ids ? all.filter((d) => ids.includes(d.id)) : all
    return { json: exportConnections(chosen, Date.now()), count: chosen.length }
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
  orca.panels.handle('doc.updateField', async ({ ns, id, path, value, remove }) => updateField(await clientFor(ns.connectionId), ns, id, path, value, remove === true))
  orca.panels.handle('doc.replace', async ({ ns, id, doc }) => replaceDocument(await clientFor(ns.connectionId), ns, id, doc))
  orca.panels.handle('doc.insert', async ({ ns, docs }) => insertDocuments(await clientFor(ns.connectionId), ns, docs))
  orca.panels.handle('doc.deleteMany', async ({ ns, ids }) => deleteDocuments(await clientFor(ns.connectionId), ns, ids))

  orca.panels.handle('query.explain', async ({ ns, spec, verbosity }) => explainFind(await clientFor(ns.connectionId), ns, spec, verbosity))

  // ---- Aggregation ----

  orca.panels.handle('agg.run', async ({ ns, pipeline, options, pageSize }) => {
    await requireDef(ns.connectionId)
    return sessions.pageAggregate(randomUUID(), ns, pipeline, options ?? {}, 0, pageSize, true)
  })
  orca.panels.handle('agg.page', async ({ queryId, ns, pipeline, options, offset, pageSize }) => {
    await requireDef(ns.connectionId)
    return sessions.pageAggregate(queryId, ns, pipeline, options ?? {}, offset, pageSize, false)
  })
  orca.panels.handle('agg.count', async ({ ns, pipeline, options }) => {
    await requireDef(ns.connectionId)
    return sessions.countAggregate(ns, pipeline, options ?? {})
  })
  orca.panels.handle('agg.preview', async ({ ns, before, stage, size, options }) => previewStage(await clientFor(ns.connectionId), ns, before, stage, size, options ?? {}))
  orca.panels.handle('agg.explain', async ({ ns, pipeline, options, verbosity }) => explainAggregate(await clientFor(ns.connectionId), ns, pipeline, options ?? {}, verbosity))
  orca.panels.handle('view.create', async ({ ns, name, pipeline }) => createView(await clientFor(ns.connectionId), ns, name, pipeline))
  orca.panels.handle('pipelines.list', ({ ns }) => pipelines.read(ns))
  orca.panels.handle('pipelines.save', ({ ns, name, stages }) => pipelines.save(ns, name, stages, Date.now()))
  orca.panels.handle('pipelines.delete', ({ ns, name }) => pipelines.remove(ns, name))

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

  const navigate = (view: 'new' | 'import' | 'export' | 'tree' | 'shell'): string => {
    orca.panels.post('ui.navigate', { view })
    return 'Shown in the Mongo Studio panel. If you do not see it, open Mongo Studio from the right sidebar.'
  }
  orca.commands.register('mongoStudio.newConnection', () => navigate('new'))
  orca.commands.register('mongoStudio.importConnections', () => navigate('import'))
  orca.commands.register('mongoStudio.exportConnections', () => navigate('export'))
  orca.commands.register('mongoStudio.showShellResults', () => navigate('shell'))
  orca.commands.register('mongoStudio.disconnectAll', async () => {
    await shells.closeAll()
    await sessions.closeAll()
    await clients.disconnectAll()
    await broadcast()
    return 'Disconnected every Mongo Studio connection.'
  })
}

export async function deactivate(): Promise<void> {
  await shell?.closeAll()
  await queries?.closeAll()
  await pool?.disconnectAll()
}
