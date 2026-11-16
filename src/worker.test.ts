// Worker protocol over Orca's mock host: storage, secrets and the panel contract. No database.
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { emptyConnection, type ConnectionDef } from './shared/model'
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
