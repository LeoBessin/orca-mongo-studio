import { assert, test } from 'orca/testing'
import { emptyConnection, SECRET_KEYS } from './model'
import type { Task } from './tasks'
import { exportConnections, importConnections, resolveTasks, type ExportedTask } from './transfer'

let n = 0
const newId = () => `new-${++n}`
const base = (id: string) => emptyConnection(id, 0)

test('export carries no secrets and import restores the definition', () => {
  const def = emptyConnection('orig', 1)
  def.name = 'Prod'
  def.group = 'Work'
  def.auth.mechanism = 'SCRAM-SHA-256'
  def.auth.username = 'app'
  def.tls.enabled = true
  def.tls.ca = { kind: 'path', path: '/etc/ca.pem' }
  def.ssh = { ...def.ssh, enabled: true, host: 'bastion', username: 'me', method: 'privateKey', privateKey: { kind: 'inline' } }
  const json = exportConnections([def], 0)
  for (const key of SECRET_KEYS) assert.equal(json.includes(`"${key}"`), false, key)
  assert.equal(json.includes('"orig"'), false, 'ids are not exported')
  const { items, errors } = importConnections(json, newId, 5, base)
  assert.deepEqual(errors, [])
  assert.equal(items.length, 1)
  const back = items[0]!
  assert.equal(back.def.name, 'Prod')
  assert.equal(back.def.group, 'Work')
  assert.deepEqual(back.def.tls.ca, { kind: 'path', path: '/etc/ca.pem' })
  // The inline key did not travel, so it must be pasted again.
  assert.deepEqual(back.def.ssh.privateKey, { kind: 'none' })
  assert.equal(back.warnings.length, 1)
  assert.match(back.def.id, /^new-/)
})

test('imports Compass exports', () => {
  const compass = JSON.stringify({
    type: 'Compass Connections',
    connections: [
      { id: 'c1', connectionOptions: { connectionString: 'mongodb://alice:pw@h1:27017/?authSource=admin' }, favorite: { name: 'Staging' } },
      { id: 'c2', connectionOptions: { connectionString: 'mongodb+srv://x.mongodb.net/', sshTunnel: { host: 'b' } } },
      { id: 'c3', connectionOptions: {} }
    ]
  })
  const { items, errors } = importConnections(compass, newId, 0, base)
  assert.equal(items.length, 2)
  assert.equal(items[0]!.def.name, 'Staging')
  assert.deepEqual(items[0]!.secrets, { password: 'pw' })
  assert.equal(items[1]!.def.name, 'x.mongodb.net')
  assert.equal(items[1]!.warnings.length, 1)
  assert.deepEqual(errors, ['Entry 3 has no connection string.'])
})

test('imports connection strings, one per line', () => {
  const { items, errors } = importConnections('# comment\nmongodb://a\n\nnot a uri\nmongodb://b:2', newId, 0, base)
  assert.deepEqual(items.map((i) => i.def.name), ['a', 'b:2'])
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /^Line 4:/)
})

test('rejects unknown JSON', () => {
  assert.deepEqual(importConnections('{"x":1}', newId, 0, base).errors, ['This JSON is neither a Mongo Studio nor a Compass export.'])
  assert.match(importConnections('{oops', newId, 0, base).errors[0]!, /not valid JSON/)
})

test('tasks go with the connections they use, by name, and resolve by name on import', () => {
  const a = { ...emptyConnection('id-a', 0), name: 'A' }
  const b = { ...emptyConnection('id-b', 0), name: 'B' }
  const ns = (connectionId: string) => ({ connectionId, db: 'shop', collection: 'orders' })
  const rules = { ignoreFields: [], ignoreOrder: false }
  const task = (id: string, name: string, request: Task['request']): Task => ({ id, name, request, createdAt: 0, updatedAt: 0, lastRun: { at: 1, status: 'done', ms: 1, summary: 'x', errorCount: 0 } })
  const copy = task('t1', 'Copy A to B', { kind: 'export', source: { kind: 'database', connectionId: 'id-a', db: 'shop' }, options: { format: 'collection', collection: { connectionId: 'id-b', db: 'shop', collection: '', mode: 'insert', indexes: true, options: true } }, destination: { kind: 'download' } })
  const sync = task('t2', 'Sync', { kind: 'sync', from: ns('id-a'), to: ns('id-a'), rules, insert: true, replace: false, remove: false })
  const file = JSON.parse(exportConnections([a, b], 0, [copy, sync])) as { tasks: ExportedTask[] }
  assert.deepEqual(file.tasks.map((t) => t.name), ['Copy A to B', 'Sync'])
  assert.equal(JSON.stringify(file.tasks).includes('id-'), false, 'no ids, no last run')
  assert.equal(JSON.stringify(file.tasks).includes('lastRun'), false)
  assert.equal(JSON.parse(exportConnections([a], 0, [copy, sync])).tasks.length, 1, 'a task using B stays behind')
  assert.equal(JSON.parse(exportConnections([a], 0, [])).tasks, undefined)

  const read = importConnections(JSON.stringify({ ...file, connections: [] }), newId, 0, base)
  assert.deepEqual(read.tasks, file.tasks)
  const imported = [{ id: 'n-a', name: 'A' }]
  const saved = [{ id: 's-a', name: 'A' }, { id: 's-b', name: 'B' }, { id: 's-b2', name: 'B' }]
  const out = resolveTasks(file.tasks, imported, saved)
  assert.deepEqual(out.tasks.map((t) => t.name), ['Sync'], 'the file\'s A comes before the saved one')
  assert.deepEqual(out.tasks[0]!.request, { ...sync.request, from: ns('n-a'), to: ns('n-a') })
  assert.deepEqual(out.errors, ['The task "Copy A to B" was not imported: more than one connection is named "B".'])
  assert.deepEqual(resolveTasks(file.tasks, [], []).errors.length, 2)

  const bad = importConnections(JSON.stringify({ format: 'mongo-studio.connections', version: 1, connections: [], tasks: [{ name: 'x' }, 3] }), newId, 0, base)
  assert.deepEqual(bad.tasks, [])
  assert.deepEqual(bad.errors, ['Task 1 of the file is not a task; it was left out.', 'Task 2 of the file is not a task; it was left out.'])
})
