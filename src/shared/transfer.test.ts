import { assert, test } from 'orca/testing'
import { emptyConnection, SECRET_KEYS } from './model'
import { exportConnections, importConnections } from './transfer'

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
