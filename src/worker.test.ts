// Worker protocol over Orca's mock host: storage, secrets and the panel contract. No database.
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { emptyConnection, type ConnectionDef } from './shared/model'
import { orcaClashes } from './shared/keys'
import * as main from './worker'

function draft(name: string): ConnectionDef {
  const def = emptyConnection('', 0)
  def.name = name
  def.auth.mechanism = 'SCRAM-SHA-256'
  def.auth.username = 'app'
  return def
}

describe('connections', () => {
  test('saves secrets to secrets:own only, and never answers them', async () => {
    const host = mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } })
    const worker = await mountWorker(main, { host })
    const saved = await worker.request('connections.save', { def: draft('Prod'), secrets: { password: 'hunter2', sshPassword: '' } })
    assert.equal(saved.ok, true)
    if (!saved.ok) return
    const data = host.data()
    assert.equal(JSON.stringify(data.storage).includes('hunter2'), false, 'storage has no password')
    assert.equal(data.secrets[`conn.${saved.id}.password`], 'hunter2')
    assert.equal(Object.keys(data.secrets).length, 1)
    const got = await worker.request('connections.get', { id: saved.id })
    assert.equal(got.secrets.password, true)
    assert.equal(got.secrets.sshPassword, false)
    assert.equal(JSON.stringify(got).includes('hunter2'), false, 'answers carry flags, not values')
    const state = await worker.request('connections.state')
    assert.deepEqual(state.connections.map((c) => [c.name, c.subtitle, c.connected]), [['Prod', 'app@localhost', false]])
    assert.ok(worker.posts.some((p) => p.event === 'connections.changed'))
    assert.deepEqual(worker.refusals, [])
  })

  test('a draft keeps, replaces or clears each secret', async () => {
    const host = mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } })
    const worker = await mountWorker(main, { host })
    const first = await worker.request('connections.save', { def: draft('A'), secrets: { password: 'one', tlsKeyPassword: 'k' } })
    assert.ok(first.ok)
    if (!first.ok) return
    const { def } = await worker.request('connections.get', { id: first.id })
    def.name = 'A2'
    await worker.request('connections.save', { def, secrets: { tlsKeyPassword: null } })
    const secrets = host.data().secrets
    assert.equal(secrets[`conn.${first.id}.password`], 'one', 'absent: kept')
    assert.equal(secrets[`conn.${first.id}.tlsKeyPassword`], undefined, 'null: cleared')
    assert.equal((await worker.request('connections.get', { id: first.id })).def.name, 'A2')
  })

  test('refuses an invalid connection with field errors', async () => {
    const worker = await mountWorker(main, { host: mockHost() })
    const def = draft('')
    def.topology = 'replicaSet'
    const result = await worker.request('connections.save', { def, secrets: {} })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.deepEqual(result.errors.map((e) => e.field), ['name', 'replicaSet'])
    assert.deepEqual((await worker.request('connections.state')).connections, [])
  })

  test('clone copies secrets; delete removes them and its favourites', async () => {
    const host = mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } })
    const worker = await mountWorker(main, { host })
    const a = await worker.request('connections.save', { def: draft('A'), secrets: { password: 'pw' } })
    assert.ok(a.ok)
    if (!a.ok) return
    const { id: b } = await worker.request('connections.clone', { id: a.id })
    assert.equal(host.data().secrets[`conn.${b}.password`], 'pw')
    assert.deepEqual((await worker.request('connections.state')).connections.map((c) => c.name), ['A', 'A (copy)'])
    await worker.request('favourites.toggle', { key: `conn:${b}/db:shop`, label: 'shop', kind: 'db', path: 'A (copy)' })
    await worker.request('connections.delete', { id: b })
    const state = await worker.request('connections.state')
    assert.deepEqual(state.connections.map((c) => c.name), ['A'])
    assert.deepEqual(state.favourites, [])
    assert.equal(host.data().secrets[`conn.${b}.password`], undefined)
  })

  test('when Orca cannot encrypt secrets, they stay in memory', async () => {
    const host = mockHost({ results: { 'secrets.protection': { status: 'unavailable' } } })
    const worker = await mountWorker(main, { host })
    const saved = await worker.request('connections.save', { def: draft('A'), secrets: { password: 'pw' } })
    assert.ok(saved.ok)
    if (!saved.ok) return
    assert.deepEqual(host.data().secrets, {})
    assert.equal((await worker.request('connections.get', { id: saved.id })).secrets.password, true)
    assert.equal((await worker.request('connections.state')).secretsProtection, 'unavailable')
  })

  test('groups rename across connections', async () => {
    const worker = await mountWorker(main, { host: mockHost() })
    for (const name of ['A', 'B']) {
      const def = draft(name)
      def.group = 'Work'
      await worker.request('connections.save', { def, secrets: {} })
    }
    await worker.request('connections.renameGroup', { from: 'Work', to: 'Clients' })
    assert.deepEqual((await worker.request('connections.state')).connections.map((c) => c.group), ['Clients', 'Clients'])
  })

  test('imports and exports without secrets', async () => {
    const host = mockHost({ results: { 'secrets.protection': { status: 'os-keyring' } } })
    const worker = await mountWorker(main, { host })
    const report = await worker.request('connections.import', { text: 'mongodb://alice:pw@db1:27018/?authSource=admin\nmongodb+srv://c.example.net' })
    assert.deepEqual(report.imported.map((i) => i.name), ['alice@db1:27018', 'c.example.net'])
    assert.equal(host.data().secrets[`conn.${report.imported[0]!.id}.password`], 'pw')
    const exported = await worker.request('connections.export', {})
    assert.equal(exported.count, 2)
    assert.equal(exported.json.includes('pw'), false)
    assert.match(exported.json, /"format": "mongo-studio.connections"/)
  })

  test('palette commands post to open panels', async () => {
    const worker = await mountWorker(main, { host: mockHost() })
    const message = await worker.command('mongoStudio.newConnection')
    assert.equal(typeof message, 'string')
    assert.deepEqual(worker.posts.at(-1), { event: 'ui.navigate', payload: { view: 'new' } })
    await worker.deactivate()
  })
})

describe('read-only connections', () => {
  async function setup() {
    const worker = await mountWorker(main, { host: mockHost() })
    const ro = draft('Prod')
    ro.readOnly = true
    const a = await worker.request('connections.save', { def: ro, secrets: {} })
    const b = await worker.request('connections.save', { def: draft('Dev'), secrets: {} })
    assert.ok(a.ok && b.ok)
    if (!a.ok || !b.ok) throw new Error('not saved')
    return { worker, ro: a.id, rw: b.id }
  }

  test('the flag is saved, shown, and kept through export and import', async () => {
    const { worker, ro } = await setup()
    const state = await worker.request('connections.state')
    assert.deepEqual(state.connections.map((c) => [c.name, c.readOnly]), [['Prod', true], ['Dev', false]])
    assert.equal((await worker.request('connections.get', { id: ro })).def.readOnly, true)
    const { json } = await worker.request('connections.export', { ids: [ro] })
    const report = await worker.request('connections.import', { text: json })
    assert.equal((await worker.request('connections.get', { id: report.imported[0]!.id })).def.readOnly, true)
  })

  test('every request that writes is refused before connecting', async () => {
    const { worker, ro, rw } = await setup()
    const ns = { connectionId: ro, db: 'shop', collection: 'orders' }
    const other = { connectionId: rw, db: 'shop', collection: 'orders' }
    const ref = { connectionId: ro, db: 'shop' }
    const grid = { ...ref, bucket: 'fs' }
    const importOptions = { format: 'json' as const, mode: 'insert' as const, drop: false, stopOnError: false, indexes: false }
    const writes: [string, unknown][] = [
      ['doc.updateField', { ns, id: 1, path: ['a'], value: 1 }],
      ['doc.replace', { ns, id: 1, doc: {} }],
      ['doc.insert', { ns, docs: [{}] }],
      ['doc.deleteMany', { ns, ids: [1] }],
      ['agg.run', { ns, pipeline: [{ $match: {} }, { $out: 'copy' }], options: {}, pageSize: 20 }],
      ['agg.page', { queryId: 'q', ns, pipeline: [{ $merge: { into: 'copy' } }], options: {}, offset: 20, pageSize: 20 }],
      ['view.create', { ns, name: 'v', pipeline: [] }],
      ['admin.createIndex', { ns, key: { a: 1 }, options: {} }],
      ['admin.dropIndex', { ns, name: 'a_1' }],
      ['admin.modifyIndex', { ns, name: 'a_1', hidden: true }],
      ['admin.setValidation', { ns, validator: null, level: 'off', action: 'error' }],
      ['admin.renameCollection', { ns, to: 'y', dropTarget: false }],
      ['admin.dropCollection', { ns }],
      ['admin.clearCollection', { ns }],
      ['admin.convertToCapped', { ns, size: 4096 }],
      ['admin.createCollection', { ...ref, spec: { name: 'x', kind: 'plain' } }],
      ['admin.dropDatabase', ref],
      ['profiler.set', { ...ref, level: 1, slowms: 100, sampleRate: 1 }],
      ['users.save', { ...ref, draft: { user: 'u', password: 'p', roles: [] }, isNew: true }],
      ['users.drop', { ...ref, user: 'u' }],
      ['roles.save', { ...ref, draft: { role: 'r', privileges: [], roles: [] }, isNew: true }],
      ['roles.drop', { ...ref, role: 'r' }],
      ['server.killOp', { connectionId: ro, opid: 1 }],
      ['import.start', { source: { kind: 'path', path: '/tmp/none.json' }, options: importOptions, ns }],
      ['export.start', { source: { kind: 'query', ns: other, spec: { filter: {}, skip: 0, limit: 0 } }, options: { format: 'collection', collection: { connectionId: ro, db: 'shop', collection: 'copy', mode: 'insert', indexes: true, options: true } }, destination: { kind: 'download' } }],
      ['compare.sync', { from: other, to: ns, rules: { ignoreFields: [], ignoreOrder: false }, insert: true, replace: false, remove: false }],
      ['gridfs.upload', { ...grid, source: { kind: 'path', path: '/tmp/none' }, filename: 'x' }],
      ['gridfs.rename', { ...grid, id: 1, filename: 'y' }],
      ['gridfs.delete', { ...grid, id: 1 }]
    ]
    const request = worker.request as unknown as (name: string, input: unknown) => Promise<unknown>
    for (const [name, input] of writes) {
      await assert.rejects(request(name, input), (raw: unknown) => {
        const error = raw as Error & { code?: string }
        assert.match(error.message, /"Prod" is read only, so Mongo Studio refuses /, name)
        assert.equal(error.code, 'not_permitted', name)
        return true
      })
    }
    // Nothing tried to connect: the refusals came first.
    assert.equal((await worker.request('connections.state')).connections.some((c) => c.connected), false)
  })

  test('a task that writes to a read-only connection is refused when run', async () => {
    const { worker, ro } = await setup()
    const ns = { connectionId: ro, db: 'shop', collection: 'orders' }
    const saved = await worker.request('tasks.save', { name: 'Load orders', request: { kind: 'import', source: { kind: 'path', path: '/tmp/orders.json' }, options: { format: 'json', mode: 'insert', drop: false, stopOnError: false, indexes: false }, ns } })
    await assert.rejects(worker.request('tasks.run', { id: saved.id }), /read only, so Mongo Studio refuses importing/)
  })
})

describe('saved tasks', () => {
  const ns = (connectionId: string, collection = 'orders') => ({ connectionId, db: 'shop', collection })
  const exportTask = (connectionId: string) => ({ kind: 'export' as const, source: { kind: 'query' as const, ns: ns(connectionId), spec: { filter: {}, skip: 0, limit: 0 } }, options: { format: 'json' as const }, destination: { kind: 'path' as const, path: '/tmp/orders.json', overwrite: true } })

  test('save, rename, duplicate, update and delete, each telling open panels', async () => {
    const host = mockHost()
    const worker = await mountWorker(main, { host })
    const conn = await worker.request('connections.save', { def: draft('Dev'), secrets: {} })
    assert.ok(conn.ok)
    if (!conn.ok) return
    const first = await worker.request('tasks.save', { name: ' Nightly export ', request: exportTask(conn.id) })
    assert.deepEqual(first.tasks.map((t) => t.name), ['Nightly export'])
    await assert.rejects(worker.request('tasks.save', { name: 'nightly EXPORT', request: exportTask(conn.id) }), /already named/)
    await assert.rejects(worker.request('tasks.save', { name: 'Paste', request: { kind: 'import', source: { kind: 'upload', uploadId: 'u' }, options: {}, ns: ns(conn.id) } as never }), /pasted text can't be saved/)
    const dup = await worker.request('tasks.duplicate', { id: first.id })
    assert.deepEqual(dup.tasks.map((t) => t.name), ['Nightly export', 'Nightly export (copy)'])
    const renamed = await worker.request('tasks.rename', { id: dup.id, name: 'Weekly export' })
    assert.deepEqual(renamed.tasks.map((t) => t.name), ['Nightly export', 'Weekly export'])
    const changed = { ...exportTask(conn.id), destination: { kind: 'path' as const, path: '/tmp/weekly.json', overwrite: false } }
    const updated = await worker.request('tasks.save', { id: dup.id, name: 'Weekly export', request: changed })
    assert.equal(updated.id, dup.id)
    assert.deepEqual(updated.tasks.find((t) => t.id === dup.id)!.request, changed)
    const left = await worker.request('tasks.delete', { id: first.id })
    assert.deepEqual(left.tasks.map((t) => t.name), ['Weekly export'])
    assert.deepEqual((await worker.request('tasks.list')).tasks.map((t) => t.id), [dup.id])
    assert.equal(worker.posts.filter((p) => p.event === 'tasks.changed').length, 5)
    assert.deepEqual(worker.refusals, [])
  })

  test('deleting a connection deletes the tasks that use it', async () => {
    const worker = await mountWorker(main, { host: mockHost() })
    const a = await worker.request('connections.save', { def: draft('A'), secrets: {} })
    const b = await worker.request('connections.save', { def: draft('B'), secrets: {} })
    assert.ok(a.ok && b.ok)
    if (!a.ok || !b.ok) return
    await worker.request('tasks.save', { name: 'Only A', request: exportTask(a.id) })
    await worker.request('tasks.save', { name: 'Only B', request: exportTask(b.id) })
    await worker.request('tasks.save', { name: 'A against B', request: { kind: 'compare', a: ns(a.id), b: ns(b.id), rules: { ignoreFields: [], ignoreOrder: false } } })
    await worker.request('connections.delete', { id: b.id })
    assert.deepEqual((await worker.request('tasks.list')).tasks.map((t) => t.name), ['Only A'])
    assert.deepEqual(worker.posts.filter((p) => p.event === 'tasks.changed').at(-1)?.payload, await worker.request('tasks.list'))
  })

  test('tasks travel with exported connections, named by connection, and find them on import', async () => {
    const from = await mountWorker(main, { host: mockHost() })
    const a = await from.request('connections.save', { def: draft('A'), secrets: {} })
    const b = await from.request('connections.save', { def: draft('B'), secrets: {} })
    assert.ok(a.ok && b.ok)
    if (!a.ok || !b.ok) return
    await from.request('tasks.save', { name: 'Only A', request: exportTask(a.id) })
    await from.request('tasks.save', { name: 'A against B', request: { kind: 'compare', a: ns(a.id), b: ns(b.id), rules: { ignoreFields: [], ignoreOrder: false } } })
    const onlyA = await from.request('connections.export', { ids: [a.id] })
    assert.equal(onlyA.tasks, 1, 'a task using B stays behind when only A is exported')
    assert.equal(onlyA.json.includes(a.id), false, 'connection ids are not exported')
    assert.equal((await from.request('connections.export', { ids: [a.id], tasks: false })).tasks, 0)
    const both = await from.request('connections.export', {})
    assert.equal(both.tasks, 2)

    // Another machine already has a task named "Only A" and a connection named B.
    const to = await mountWorker(main, { host: mockHost() })
    const theirB = await to.request('connections.save', { def: draft('B'), secrets: {} })
    assert.ok(theirB.ok)
    if (!theirB.ok) return
    await to.request('tasks.save', { name: 'Only A', request: exportTask(theirB.id) })
    const file = JSON.parse(both.json) as { connections: unknown[] }
    file.connections = file.connections.slice(0, 1)
    const report = await to.request('connections.import', { text: JSON.stringify(file) })
    assert.deepEqual(report.errors, [])
    assert.deepEqual(report.tasks, ['Only A (2)', 'A against B'])
    const newA = report.imported[0]!.id
    const list = (await to.request('tasks.list')).tasks
    assert.deepEqual(list.find((t) => t.name === 'Only A (2)')!.request, exportTask(newA))
    assert.deepEqual(list.find((t) => t.name === 'A against B')!.request, { kind: 'compare', a: ns(newA), b: ns(theirB.id), rules: { ignoreFields: [], ignoreOrder: false } })
    assert.deepEqual(to.posts.filter((p) => p.event === 'tasks.changed').at(-1)?.payload, { tasks: list })

    // Without a connection named B, the compare can't be placed and says why.
    const lone = await mountWorker(main, { host: mockHost() })
    const partial = await lone.request('connections.import', { text: JSON.stringify(file) })
    assert.deepEqual(partial.tasks, ['Only A'])
    assert.deepEqual(partial.errors, ['The task "A against B" was not imported: no connection is named "B".'])
    assert.deepEqual([from.refusals, to.refusals, lone.refusals], [[], [], []])
  })

  test('"Show saved tasks" posts to open panels', async () => {
    const worker = await mountWorker(main, { host: mockHost() })
    await worker.command('mongoStudio.showTasks')
    assert.deepEqual(worker.posts.at(-1), { event: 'ui.navigate', payload: { view: 'tasks' } })
    await worker.deactivate()
  })
})

describe('the manifest\'s keybindings', () => {
  test('name contributed commands and stay clear of Orca\'s shortcuts', async () => {
    const { readFileSync } = await import('node:fs')
    const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as { contributes: { commands: { id: string }[]; keybindings: { command: string; key: string }[] } }
    const commands = new Set(manifest.contributes.commands.map((c) => c.id))
    assert.ok(manifest.contributes.keybindings.length > 0)
    for (const k of manifest.contributes.keybindings) {
      assert.ok(commands.has(k.command), k.command)
      for (const p of ['darwin', 'linux', 'win32'] as const) assert.equal(orcaClashes(k.key, p), false, `${k.key} on ${p}`)
    }
  })
})
